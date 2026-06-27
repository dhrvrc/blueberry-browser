import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import type { AgentEvent, AutomationSummary, StepStatus } from '../../../../shared/ipc-schema'

export interface StepState {
    stepId: string
    label: string
    status: StepStatus
    detail?: string
}

export interface ObservationState {
    id: number
    stream: 'stdout' | 'return' | 'error' | 'warn'
    text: string
}

export interface ApprovalRequest {
    requestId: string
    message: string
}

/** State for a single agent (root or child). */
export interface AgentState {
    agentId: string
    parentId: string | null
    task: string
    running: boolean
    reasoning: string
    code: string
    steps: StepState[]
    observations: ObservationState[]
    lastApproval: ApprovalRequest | null
    statusText: string
    lastRunOk: boolean | null
    result: string | null
    /** Set when the model answered conversationally (no code) — rendered as a chat reply. */
    answer: string | null
    /** Files the agent generated this run, shown as clickable cards. */
    files: GeneratedFile[]
}

export interface GeneratedFile {
    name: string
    fileType: 'csv' | 'md' | 'html' | 'text'
    url: string
}

/** One chat turn: the user's task + the agent tree for that run (root + spawned). */
export interface Turn {
    id: number
    task: string
    rootAgentId: string
    agents: Record<string, AgentState>
}

interface AgentContextType {
    // Conversation history — one entry per task, newest last (chat style).
    turns: Turn[]
    rootAgentId: string | null

    // Automations
    automations: AutomationSummary[]

    // Actions
    runAgent: (task: string) => Promise<void>
    /** Abort an agent and all its descendants. Defaults to root. */
    abortAgent: (agentId?: string) => void
    /** Approve/deny an approval request for a specific agent. */
    approve: (agentId: string, requestId: string, approved: boolean) => void
    /** Open an agent-generated file (its file:// viewer) in a new browser tab. */
    openFile: (url: string) => void
    saveAutomation: (name: string) => Promise<void>
    replayAutomation: (id: string) => Promise<void>
    refreshAutomations: () => Promise<void>
}

const AgentContext = createContext<AgentContextType | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export const useAgent = (): AgentContextType => {
    const ctx = useContext(AgentContext)
    if (!ctx) throw new Error('useAgent must be used within an AgentProvider')
    return ctx
}

// The root agent's stable id (matches AgentService.agentId in main).
const ROOT_AGENT_ID = 'agent-1'

let obsCounter = 0
let turnCounter = 0

function makeAgentState(agentId: string, parentId: string | null, task: string): AgentState {
    return {
        agentId,
        parentId,
        task,
        running: false,
        reasoning: '',
        code: '',
        steps: [],
        observations: [],
        lastApproval: null,
        statusText: '',
        lastRunOk: null,
        result: null,
        answer: null,
        files: [],
    }
}

export const AgentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // Conversation history: each task is a turn. Events route into the LAST turn.
    const [turns, setTurns] = useState<Turn[]>([])
    const [rootAgentId, setRootAgentId] = useState<string | null>(null)
    const [automations, setAutomations] = useState<AutomationSummary[]>([])

    // Stable ref for rootAgentId used inside the event handler.
    const rootAgentIdRef = useRef<string | null>(null)

    // Update an agent within the current (last) turn; create the entry if new.
    const upsertAgent = useCallback((
        agentId: string,
        updater: (prev: AgentState) => AgentState,
        defaultState?: AgentState,
    ) => {
        setTurns((prevTurns) => {
            if (prevTurns.length === 0) return prevTurns
            const idx = prevTurns.length - 1
            const turn = prevTurns[idx]
            const existing = turn.agents[agentId] ?? defaultState ?? makeAgentState(agentId, null, '')
            const nextTurn: Turn = {
                ...turn,
                agents: { ...turn.agents, [agentId]: updater(existing) },
            }
            const next = [...prevTurns]
            next[idx] = nextTurn
            return next
        })
    }, [])

    const handleEvent = useCallback((e: AgentEvent) => {
        switch (e.kind) {
            case 'agent-spawned':
                // Create a new child agent entry.
                upsertAgent(e.agentId, (prev) => prev, makeAgentState(e.agentId, e.parentId, e.task))
                break

            case 'agent-done':
                upsertAgent(e.agentId, (prev) => ({
                    ...prev,
                    running: false,
                    lastRunOk: e.ok,
                    result: e.result ?? null,
                }))
                break

            case 'run-start':
                upsertAgent(e.agentId, (prev) => ({
                    ...prev,
                    task: e.task,
                    running: true,
                    reasoning: '',
                    code: '',
                    steps: [],
                    observations: [],
                    lastApproval: null,
                    statusText: '',
                    lastRunOk: null,
                    result: null,
                    answer: null,
                    files: [],
                }))
                break

            case 'answer':
                // The model answered conversationally (no code) — show as a chat reply.
                upsertAgent(e.agentId, (prev) => ({ ...prev, answer: e.text }))
                break

            case 'file':
                upsertAgent(e.agentId, (prev) => ({
                    ...prev,
                    files: [...prev.files, { name: e.name, fileType: e.fileType, url: e.url }],
                }))
                break

            case 'attempt-start': {
                // A retry: clear the failed attempt's streamed reasoning/code/answer
                // AND remove the stale sub-agents it spawned (they belong to the
                // failed attempt and would otherwise linger below the new code).
                const aid = e.agentId
                setTurns((prevTurns) => {
                    if (prevTurns.length === 0) return prevTurns
                    const idx = prevTurns.length - 1
                    const turn = prevTurns[idx]
                    const nextAgents: Record<string, AgentState> = {}
                    for (const [id, a] of Object.entries(turn.agents)) {
                        // Drop descendants of the retrying agent.
                        if (id !== aid && id.startsWith(aid + '.')) continue
                        nextAgents[id] = id === aid ? { ...a, reasoning: '', code: '', answer: null } : a
                    }
                    const next = [...prevTurns]
                    next[idx] = { ...turn, agents: nextAgents }
                    return next
                })
                break
            }

            case 'reasoning':
                upsertAgent(e.agentId, (prev) => ({
                    ...prev,
                    reasoning: prev.reasoning + e.text,
                }))
                break

            case 'code':
                upsertAgent(e.agentId, (prev) => ({
                    ...prev,
                    code: prev.code + e.delta,
                }))
                break

            case 'code-complete':
                upsertAgent(e.agentId, (prev) => ({ ...prev, code: e.code }))
                break

            case 'step':
                upsertAgent(e.agentId, (prev) => {
                    const updated = { stepId: e.stepId, label: e.label, status: e.status, detail: e.detail }
                    const idx = prev.steps.findIndex((s) => s.stepId === e.stepId)
                    if (idx >= 0) {
                        const next = [...prev.steps]
                        next[idx] = updated
                        return { ...prev, steps: next }
                    }
                    return { ...prev, steps: [...prev.steps, updated] }
                })
                break

            case 'observation':
                upsertAgent(e.agentId, (prev) => ({
                    ...prev,
                    observations: [...prev.observations, { id: ++obsCounter, stream: e.stream, text: e.text }],
                }))
                break

            case 'status':
                upsertAgent(e.agentId, (prev) => ({ ...prev, statusText: e.text }))
                break

            case 'approval-request':
                upsertAgent(e.agentId, (prev) => ({
                    ...prev,
                    lastApproval: { requestId: e.requestId, message: e.message },
                }))
                break

            case 'approval-resolved':
                upsertAgent(e.agentId, (prev) => ({ ...prev, lastApproval: null }))
                break

            case 'run-end':
                upsertAgent(e.agentId, (prev) => ({
                    ...prev,
                    running: false,
                    lastRunOk: e.ok,
                    // Surface a failure reason so the user isn't left with a silent
                    // dead run (e.g. rate-limit / too-large errors).
                    observations: !e.ok && e.error && e.error !== 'aborted'
                        ? [...prev.observations, { id: ++obsCounter, stream: 'error' as const, text: e.error }]
                        : prev.observations,
                }))
                break

            // overlay events: not stored in context state (AgentPanel handles visual feedback)
            default:
                break
        }
    }, [upsertAgent])

    useEffect(() => {
        window.sidebarAPI.onAgentEvent(handleEvent)
        return () => { window.sidebarAPI.removeAgentEventListener() }
    }, [handleEvent])

    const runAgent = useCallback(async (task: string) => {
        // Append the new turn BEFORE starting the run. The run's `run-start`
        // event can arrive (via the event stream) before the IPC call resolves;
        // if the new turn isn't in place yet, that event would reset the PREVIOUS
        // turn's state (wiping its file cards). The root agentId is the stable
        // "agent-1", so we can seed the turn without waiting for the result.
        const id = ROOT_AGENT_ID
        rootAgentIdRef.current = id
        setRootAgentId(id)
        setTurns((prev) => [
            ...prev,
            { id: ++turnCounter, task, rootAgentId: id, agents: { [id]: makeAgentState(id, null, task) } },
        ])
        await window.sidebarAPI.runAgent(task)
    }, [])

    const abortAgent = useCallback((agentId?: string) => {
        const id = agentId ?? rootAgentIdRef.current
        if (id) window.sidebarAPI.abortAgent(id)
    }, [])

    const approve = useCallback((agentId: string, requestId: string, approved: boolean) => {
        window.sidebarAPI.approveAction(agentId, requestId, approved)
    }, [])

    const openFile = useCallback((url: string) => {
        window.sidebarAPI.openFile(url)
    }, [])

    const refreshAutomations = useCallback(async () => {
        try {
            const list = await window.sidebarAPI.listAutomations()
            setAutomations(list)
        } catch (e) {
            console.error('Failed to list automations', e)
        }
    }, [])

    const saveAutomation = useCallback(async (name: string) => {
        const id = rootAgentIdRef.current
        if (!id) return
        await window.sidebarAPI.saveAutomation(id, name)
        await refreshAutomations()
    }, [refreshAutomations])

    const replayAutomation = useCallback(async (id: string) => {
        const result = await window.sidebarAPI.replayAutomation(id)
        if (result) {
            const id = result.agentId
            rootAgentIdRef.current = id
            setRootAgentId(id)
            setTurns((prev) => [
                ...prev,
                { id: ++turnCounter, task: '(replay)', rootAgentId: id, agents: { [id]: makeAgentState(id, null, '(replay)') } },
            ])
        }
    }, [])

    useEffect(() => { refreshAutomations() }, [refreshAutomations])

    const value: AgentContextType = {
        turns,
        rootAgentId,
        automations,
        runAgent,
        abortAgent,
        approve,
        openFile,
        saveAutomation,
        replayAutomation,
        refreshAutomations,
    }

    return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}
