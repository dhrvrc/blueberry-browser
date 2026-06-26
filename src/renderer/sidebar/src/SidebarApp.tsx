import React, { useEffect } from 'react'
import { AgentProvider } from './contexts/AgentContext'
import { AgentPanel } from './components/AgentPanel'
import { useDarkMode } from '@common/hooks/useDarkMode'

const SidebarContent: React.FC = () => {
    const { isDarkMode } = useDarkMode()

    // Apply dark mode class to the document
    useEffect(() => {
        if (isDarkMode) {
            document.documentElement.classList.add('dark')
        } else {
            document.documentElement.classList.remove('dark')
        }
    }, [isDarkMode])

    return (
        <div className="h-screen flex flex-col bg-background border-l border-border">
            {/* Header */}
            <div className="flex-shrink-0 flex items-center justify-center px-4 pt-3 pb-2">
                <span className="text-sm font-semibold text-foreground">🫐🤖 blueberry</span>
            </div>

            {/* The unified blueberry panel — chats or runs agent code as needed. */}
            <div className="flex-1 min-h-0">
                <AgentPanel />
            </div>
        </div>
    )
}

export const SidebarApp: React.FC = () => {
    return (
        <AgentProvider>
            <SidebarContent />
        </AgentProvider>
    )
}
