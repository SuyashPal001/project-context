'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function parseEmailEntries(text: string): Array<{ from: string; subject: string; date: string; snippet?: string }> | null {
    if (!text.includes('**From:**')) return null
    const blocks = text.split(/\n\s*\n|\n---\n/)
    const result: Array<{ from: string; subject: string; date: string; snippet?: string }> = []
    for (const block of blocks) {
        if (!block.includes('**From:**')) continue
        const from = block.match(/\*\*From:\*\*\s*(.+)/)?.[1]?.trim() ?? ''
        const subject = block.match(/\*\*Subject:\*\*\s*(.+)/)?.[1]?.trim() ?? ''
        const date = block.match(/\*\*Date:\*\*\s*(.+)/)?.[1]?.trim() ?? ''
        const snippet = block.match(/\*\*Snippet:\*\*\s*(.+)/)?.[1]?.trim()
        if (from || subject) result.push({ from, subject, date, snippet })
    }
    return result.length > 0 ? result : null
}

export function AgentOutputRenderer({ content }: { content: string }) {
    const emails = parseEmailEntries(content)
    if (emails) {
        return (
            <div className="space-y-2">
                {emails.map((email, i) => (
                    <div key={i} className="rounded-lg border border-[#2a2a2a] bg-[#0f0f0f] px-3 py-2.5 text-xs">
                        <div className="flex flex-col gap-0.5">
                            <div className="flex gap-2"><span className="text-muted-foreground/60 w-14 flex-shrink-0">From</span><span className="text-foreground/80 truncate">{email.from}</span></div>
                            <div className="flex gap-2"><span className="text-muted-foreground/60 w-14 flex-shrink-0">Subject</span><span className="text-foreground font-medium truncate">{email.subject}</span></div>
                            {email.date && <div className="flex gap-2"><span className="text-muted-foreground/60 w-14 flex-shrink-0">Date</span><span className="text-muted-foreground/80">{email.date}</span></div>}
                            {email.snippet && <div className="mt-1 text-muted-foreground/50 italic leading-relaxed line-clamp-2">{email.snippet}</div>}
                        </div>
                    </div>
                ))}
            </div>
        )
    }
    return (
        <div className="prose prose-invert prose-xs max-w-none text-xs leading-relaxed
            [&_p]:text-foreground/80 [&_p]:my-1
            [&_ul]:my-1 [&_ul]:pl-4 [&_li]:text-foreground/80 [&_li]:my-0.5
            [&_ol]:my-1 [&_ol]:pl-4
            [&_strong]:text-foreground [&_strong]:font-semibold
            [&_code]:bg-[#1a1a1a] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-emerald-400 [&_code]:font-mono
            [&_pre]:bg-[#1a1a1a] [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto
            [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-xs [&_h2]:font-semibold [&_h3]:text-xs [&_h3]:font-medium
            [&_blockquote]:border-l-2 [&_blockquote]:border-[#2a2a2a] [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground/70
            [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2
            [&_hr]:border-[#2a2a2a]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
    )
}
