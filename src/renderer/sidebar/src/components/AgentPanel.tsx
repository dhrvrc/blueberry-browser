import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { Square, Play, Save, RotateCcw, Check, X, ChevronDown, ChevronRight, FileText, Table, Code, FileType as FileTypeIcon } from 'lucide-react'
import { useAgent, type AgentState, type StepState, type ObservationState, type GeneratedFile } from '../contexts/AgentContext'
import { cn } from '@common/lib/utils'
import { Button } from '@common/components/Button'

// File card (Claude/ChatGPT style) — click to open the rendered viewer in a tab.
const FILE_META: Record<GeneratedFile['fileType'], { label: string; Icon: typeof FileText }> = {
    csv: { label: 'CSV', Icon: Table },
    md: { label: 'Markdown', Icon: FileText },
    html: { label: 'HTML', Icon: Code },
    text: { label: 'Text', Icon: FileTypeIcon },
}

const FileCard: React.FC<{ file: GeneratedFile; onOpen: (url: string) => void }> = ({ file, onOpen }) => {
    const { label, Icon } = FILE_META[file.fileType]
    return (
        <button
            onClick={() => onOpen(file.url)}
            className="flex items-center gap-3 w-full text-left border border-border rounded-xl px-3 py-2.5 bg-background hover:bg-muted/50 transition-colors"
        >
            <span className="flex-shrink-0 size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground truncate">{file.name}</span>
                <span className="block text-xs text-muted-foreground">{label} · click to open</span>
            </span>
        </button>
    )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

const StatusIcon: React.FC<{ status: StepState['status'] }> = ({ status }) => {
    const base = "size-3 rounded-full flex-shrink-0 mt-0.5"
    if (status === 'running') return <span className={cn(base, "bg-blue-400 animate-pulse")} />
    if (status === 'done') return <span className={cn(base, "bg-green-500")} />
    if (status === 'error') return <span className={cn(base, "bg-red-500")} />
    return <span className={cn(base, "bg-muted-foreground/40")} />
}

const StepTimeline: React.FC<{ steps: StepState[] }> = ({ steps }) => {
    if (steps.length === 0) return null
    return (
        <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Steps</p>
            <div className="space-y-1">
                {steps.map((s) => (
                    <div key={s.stepId} className="flex items-start gap-2 text-sm">
                        <StatusIcon status={s.status} />
                        <div className="min-w-0">
                            <span className="text-foreground">{s.label}</span>
                            {s.detail && <p className="text-xs text-muted-foreground truncate">{s.detail}</p>}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}

const ObservationRow: React.FC<{ obs: ObservationState }> = ({ obs }) => {
    const colorClass = {
        stdout: 'text-foreground',
        return: 'text-green-600 dark:text-green-400',
        error: 'text-red-600 dark:text-red-400',
        warn: 'text-yellow-600 dark:text-yellow-400',
    }[obs.stream]

    return (
        <div className={cn("font-mono text-xs whitespace-pre-wrap break-all", colorClass)}>
            {obs.text}
        </div>
    )
}

const ObservationsLog: React.FC<{ observations: ObservationState[] }> = ({ observations }) => {
    if (observations.length === 0) return null
    return (
        <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Output</p>
            {/* No inner scroll — content flows in the panel's single scroll container
                so the whole run reads top-to-bottom with new output at the bottom. */}
            <div className="bg-muted/50 dark:bg-muted/30 rounded-lg p-3 space-y-0.5">
                {observations.map((obs) => <ObservationRow key={obs.id} obs={obs} />)}
            </div>
        </div>
    )
}

const ReasoningBlock: React.FC<{ text: string }> = ({ text }) => {
    const [open, setOpen] = useState(true)
    if (!text) return null
    return (
        <div className="space-y-1">
            <button
                onClick={() => setOpen(o => !o)}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
                {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                Reasoning
            </button>
            {open && (
                <div className="text-sm text-muted-foreground italic whitespace-pre-wrap bg-muted/30 rounded-lg p-3">
                    {text}
                </div>
            )}
        </div>
    )
}

const CodeBlock: React.FC<{ code: string }> = ({ code }) => {
    // Collapsed by default (like ChatGPT/Claude): a header + a one-line preview;
    // click to expand the full program.
    const [open, setOpen] = useState(false)
    if (!code) return null
    const lineCount = code.split('\n').length
    const firstLine = code.split('\n').find((l) => l.trim().length > 0) ?? ''

    return (
        <div className="rounded-lg border border-border bg-muted/50 dark:bg-muted/30 overflow-hidden">
            <button
                onClick={() => setOpen((o) => !o)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/60 transition-colors"
            >
                {open ? <ChevronDown className="size-3 flex-shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 flex-shrink-0 text-muted-foreground" />}
                <span className="text-xs font-medium text-muted-foreground">Code</span>
                <span className="text-[10px] text-muted-foreground/70">{lineCount} {lineCount === 1 ? 'line' : 'lines'}</span>
                {!open && (
                    <span className="text-xs font-mono text-muted-foreground/80 truncate flex-1 min-w-0">
                        {firstLine}
                    </span>
                )}
            </button>
            {open && (
                <pre className="px-3 pb-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
                    {code}
                </pre>
            )}
        </div>
    )
}

const ApprovalPrompt: React.FC<{
    requestId: string
    message: string
    onApprove: (approved: boolean) => void
}> = ({ message, onApprove }) => (
    <div className="border border-yellow-400/50 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-3 space-y-2">
        <p className="text-xs font-medium text-yellow-700 dark:text-yellow-400 uppercase tracking-wider">
            Approval Required
        </p>
        <p className="text-sm text-foreground">{message}</p>
        <div className="flex gap-2">
            <button
                onClick={() => onApprove(true)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-green-600 text-white rounded-md hover:bg-green-700"
            >
                <Check className="size-3" /> Approve
            </button>
            <button
                onClick={() => onApprove(false)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-red-600 text-white rounded-md hover:bg-red-700"
            >
                <X className="size-3" /> Deny
            </button>
        </div>
    </div>
)

// ─── AgentNode — renders one agent's five channels, recursively renders children ─

interface AgentNodeProps {
    agent: AgentState
    agents: Record<string, AgentState>
    depth: number
    approve: (agentId: string, requestId: string, approved: boolean) => void
    openFile: (url: string) => void
}

const AgentNode: React.FC<AgentNodeProps> = ({ agent, agents, depth, approve, openFile }) => {
    const [open, setOpen] = useState(true)

    const children = Object.values(agents).filter((a) => a.parentId === agent.agentId)
    const isChild = depth > 0

    return (
        <div className={cn("space-y-3", isChild && "border-l-2 border-border pl-3 ml-1")}>
            {/* Child agent header */}
            {isChild && (
                <button
                    onClick={() => setOpen(o => !o)}
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground w-full text-left"
                >
                    {open ? <ChevronDown className="size-3 flex-shrink-0" /> : <ChevronRight className="size-3 flex-shrink-0" />}
                    <span className="px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 rounded text-xs font-mono">
                        spawned
                    </span>
                    <span className="truncate text-foreground">{agent.task || agent.agentId}</span>
                    {agent.running && (
                        <span className="size-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
                    )}
                </button>
            )}

            {open && (
                agent.answer !== null ? (
                    // Conversational reply (no code was run) — render as a chat message.
                    <div className="text-foreground whitespace-pre-wrap leading-relaxed text-sm">
                        {agent.answer}
                    </div>
                ) : (
                <div className="space-y-3">
                    {/* Status banner */}
                    {agent.statusText && (
                        <div className="text-xs text-muted-foreground bg-muted/40 rounded px-3 py-2">
                            {agent.statusText}
                        </div>
                    )}

                    {/* Reasoning */}
                    <ReasoningBlock text={agent.reasoning} />

                    {/* Streaming code */}
                    <CodeBlock code={agent.code} />

                    {/* Step timeline */}
                    <StepTimeline steps={agent.steps} />

                    {/* Inline approval */}
                    {agent.lastApproval && (
                        <ApprovalPrompt
                            requestId={agent.lastApproval.requestId}
                            message={agent.lastApproval.message}
                            onApprove={(a) => approve(agent.agentId, agent.lastApproval!.requestId, a)}
                        />
                    )}

                    {/* Spawned children run here — shown BEFORE this agent's
                        observations so the parent's aggregated result lands at
                        the bottom, after the children that produced it. */}
                    {children.map((child) => (
                        <AgentNode
                            key={child.agentId}
                            agent={child}
                            agents={agents}
                            depth={depth + 1}
                            approve={approve}
                            openFile={openFile}
                        />
                    ))}

                    {/* Observations (incl. the final aggregated return) */}
                    <ObservationsLog observations={agent.observations} />

                    {/* Generated file cards — click to open the rendered viewer */}
                    {agent.files.length > 0 && (
                        <div className="space-y-1.5">
                            {agent.files.map((f, i) => (
                                <FileCard key={`${f.url}-${i}`} file={f} onOpen={openFile} />
                            ))}
                        </div>
                    )}
                </div>
                )
            )}
        </div>
    )
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

export const AgentPanel: React.FC = () => {
    const {
        turns,
        automations,
        runAgent,
        abortAgent,
        approve,
        openFile,
        saveAutomation,
        replayAutomation,
        refreshAutomations,
    } = useAgent()

    const [task, setTask] = useState('')
    const [saveName, setSaveName] = useState('')
    const [showSaveInput, setShowSaveInput] = useState(false)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const scrollRef = useRef<HTMLDivElement>(null)

    // Follow the bottom as the conversation streams: total content across every
    // turn's agents is a cheap proxy for "something changed".
    const contentSize = turns.reduce(
        (sum, t) => sum + Object.values(t.agents).reduce(
            (n, a) => n + a.reasoning.length + a.code.length + a.steps.length + a.observations.length,
            0,
        ),
        turns.length,
    )
    useLayoutEffect(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
    }, [contentSize])

    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
        }
    }, [task])

    // Refresh automations when panel mounts.
    useEffect(() => { refreshAutomations() }, [refreshAutomations])

    const handleRun = async (): Promise<void> => {
        if (!task.trim() || anyRunning) return
        await runAgent(task.trim())
        setTask('')
    }

    const handleSave = async (): Promise<void> => {
        if (!saveName.trim()) return
        await saveAutomation(saveName.trim())
        setSaveName('')
        setShowSaveInput(false)
    }

    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null
    const lastRoot = lastTurn ? lastTurn.agents[lastTurn.rootAgentId] : null
    // Only the CURRENT turn gates the input — a stuck flag in past history must
    // never lock the chat. The run is "running" while its root agent is running.
    const anyRunning = lastRoot?.running === true

    return (
        <div className="flex flex-col h-full bg-background">
            {/* Output Area */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto px-4 py-4 space-y-6">
                    {turns.length === 0 && (
                        <div className="flex items-center justify-center min-h-[300px]">
                            <div className="text-center space-y-2 animate-fade-in max-w-md">
                                <h3 className="text-2xl font-bold">🫐🤖</h3>
                                <p className="text-muted-foreground text-sm">
                                    Ask a question or describe a task. Blueberry answers directly, or
                                    writes and runs code to do it for you.
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Conversation: one block per task (chat style, newest at bottom) */}
                    {turns.map((turn) => {
                        const root = turn.agents[turn.rootAgentId]
                        return (
                            <div key={turn.id} className="space-y-3">
                                {/* User task bubble */}
                                <div className="max-w-[85%] ml-auto">
                                    <div className="bg-muted dark:bg-muted/50 rounded-3xl px-5 py-3">
                                        <div className="text-foreground whitespace-pre-wrap">{turn.task}</div>
                                    </div>
                                </div>
                                {/* Agent run for this task */}
                                {root && (
                                    <AgentNode
                                        agent={root}
                                        agents={turn.agents}
                                        depth={0}
                                        approve={approve}
                                        openFile={openFile}
                                    />
                                )}
                            </div>
                        )
                    })}

                    {/* Post-run: save button for the latest run */}
                    {lastRoot && lastRoot.lastRunOk === true && lastRoot.code && (
                        <div className="space-y-2">
                            {!showSaveInput ? (
                                <Button
                                    variant="ghost"
                                    onClick={() => setShowSaveInput(true)}
                                >
                                    <Save className="size-4" /> Save as Automation
                                </Button>
                            ) : (
                                <div className="flex gap-2 items-center">
                                    <input
                                        type="text"
                                        value={saveName}
                                        onChange={(e) => setSaveName(e.target.value)}
                                        placeholder="Automation name…"
                                        className="flex-1 text-sm border border-border rounded-lg px-3 py-2 bg-background outline-none focus:border-primary/40"
                                        onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                                        autoFocus
                                    />
                                    <button
                                        onClick={handleSave}
                                        disabled={!saveName.trim()}
                                        className="px-3 py-2 text-sm bg-primary text-primary-foreground rounded-lg disabled:opacity-50 hover:opacity-80"
                                    >
                                        Save
                                    </button>
                                    <button
                                        onClick={() => setShowSaveInput(false)}
                                        className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Saved automations */}
                    {automations.length > 0 && (
                        <div className="space-y-2 pt-2 border-t border-border">
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                Saved Automations
                            </p>
                            <div className="space-y-1">
                                {automations.map((a) => (
                                    <div
                                        key={a.id}
                                        className="flex items-center gap-2 text-sm group"
                                    >
                                        <span className="flex-1 truncate text-foreground" title={a.task}>
                                            {a.name}
                                        </span>
                                        <button
                                            onClick={() => replayAutomation(a.id)}
                                            disabled={anyRunning}
                                            className={cn(
                                                "flex items-center gap-1 px-2 py-1 text-xs rounded",
                                                "text-muted-foreground hover:text-primary hover:bg-primary/10",
                                                "disabled:opacity-40",
                                            )}
                                            title={`Replay: ${a.task}`}
                                        >
                                            <RotateCcw className="size-3" /> Replay
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Input Area */}
            <div className="p-4">
                <div className={cn(
                    "w-full border p-3 rounded-3xl bg-background dark:bg-secondary",
                    "shadow-chat animate-spring-scale outline-none transition-all duration-200 border-border",
                )}>
                    <div className="w-full px-3 py-2">
                        <textarea
                            ref={textareaRef}
                            value={task}
                            onChange={(e) => setTask(e.target.value)}
                            placeholder="Ask blueberry anything, or give it a task…"
                            className="w-full resize-none outline-none bg-transparent text-foreground placeholder:text-muted-foreground min-h-[24px] max-h-[160px]"
                            rows={1}
                            style={{ lineHeight: '24px' }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault()
                                    handleRun()
                                }
                            }}
                        />
                    </div>
                    <div className="w-full flex items-center gap-1.5 px-1 mt-2 mb-1">
                        <div className="flex-1" />
                        {anyRunning ? (
                            <button
                                onClick={() => abortAgent(lastTurn?.rootAgentId)}
                                className="size-9 rounded-full flex items-center justify-center bg-red-500 text-white hover:opacity-80"
                                title="Stop agent"
                            >
                                <Square className="size-4" />
                            </button>
                        ) : (
                            <button
                                onClick={handleRun}
                                disabled={!task.trim()}
                                className={cn(
                                    "size-9 rounded-full flex items-center justify-center",
                                    "bg-primary text-primary-foreground hover:opacity-80 disabled:opacity-50",
                                )}
                            >
                                <Play className="size-4" />
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}
