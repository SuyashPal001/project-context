'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { StarterKit } from '@tiptap/starter-kit'
import { Extension } from '@tiptap/core'
import { Suggestion } from '@tiptap/suggestion'
import { Underline } from '@tiptap/extension-underline'
import { Placeholder } from '@tiptap/extension-placeholder'
import { Link } from '@tiptap/extension-link'
import { Heading } from '@tiptap/extension-heading'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { Mention } from '@tiptap/extension-mention'
import { createLowlight, common } from 'lowlight'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
    Bold, Italic, Underline as UnderlineIcon, Strikethrough,
    Code, Heading1, Heading2, Heading3,
    List, ListOrdered, CheckSquare, Link2, Lock,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useMentionSuggestions } from '@/hooks/use-mention-suggestions'
import { createMentionSuggestion } from '../editor/mention-suggestion'
import { createSlashSuggestion } from './slash-commands/createSlashSuggestion'
import { pagesKeys } from '@/lib/query-keys/pm'

const lowlight = createLowlight(common)

interface PageEditorProps {
    pageId: string
    initialHtml: string | null | undefined
    isLocked: boolean
    onSave?: (html: string) => void
}

export function PageEditor({ pageId, initialHtml, isLocked, onSave }: PageEditorProps) {
    const queryClient = useQueryClient()
    const isEditingRef = useRef(false)
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const allItems = useMentionSuggestions()
    const allItemsRef = useRef(allItems)
    useEffect(() => { allItemsRef.current = allItems }, [allItems])

    const patchPage = useMutation({
        mutationFn: ({ descriptionHtml, descriptionJson }: { descriptionHtml: string; descriptionJson: object }) =>
            api.patch(`/api/v1/pages/${pageId}`, { descriptionHtml, descriptionJson }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: pagesKeys.detail(pageId) })
            onSave?.(editor?.getHTML() ?? '')
        },
    })

    const triggerSave = useCallback((html: string, json: object) => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => {
            patchPage.mutate({ descriptionHtml: html, descriptionJson: json })
        }, 1500)
    }, [patchPage])

    const editor = useEditor({
        extensions: [
            StarterKit.configure({ heading: false, codeBlock: false, link: false, underline: false }),
            Underline,
            Heading.configure({ levels: [1, 2, 3] }),
            CodeBlockLowlight.configure({ lowlight }),
            TaskList,
            TaskItem.configure({ nested: true }),
            Placeholder.configure({ placeholder: 'Start writing…', showOnlyWhenEditable: false }),
            Link.configure({ openOnClick: false }),
            Mention.configure({
                HTMLAttributes: { class: 'mention' },
                suggestion: createMentionSuggestion(() => allItemsRef.current),
            }),
            Extension.create({
                name: 'slashCommands',
                addOptions() { return { suggestion: createSlashSuggestion() } },
                addProseMirrorPlugins() {
                    return [Suggestion({ editor: this.editor, ...this.options.suggestion })]
                },
            }),
        ],
        content: initialHtml ?? '',
        editable: false,
        editorProps: { attributes: { class: 'outline-none min-h-[4rem]' } },
        onUpdate: ({ editor: ed }) => {
            if (!isEditingRef.current) return
            triggerSave(ed.getHTML(), ed.getJSON())
        },
    })

    // Sync lock → editable
    useEffect(() => {
        if (!editor) return
        if (isLocked) {
            editor.setEditable(false)
            isEditingRef.current = false
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        }
    }, [editor, isLocked])

    // Re-sync content when pageId changes (navigate between pages)
    const pageIdRef = useRef(pageId)
    useEffect(() => {
        if (!editor || pageId === pageIdRef.current) return
        pageIdRef.current = pageId
        editor.commands.setContent(initialHtml ?? '', { emitUpdate: false })
        editor.setEditable(false)
        isEditingRef.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pageId])

    const enterEdit = useCallback(() => {
        if (!editor || isLocked || isEditingRef.current) return
        editor.setEditable(true)
        isEditingRef.current = true
        editor.commands.focus()
    }, [editor, isLocked])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && isEditingRef.current) { editor?.setEditable(false); isEditingRef.current = false } }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [editor])

    useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }, [])

    if (!editor) return null

    return (
        <div className="group relative" onClick={enterEdit}>
            {!isLocked && (
                <BubbleMenu editor={editor} options={{ placement: 'top-start' }} shouldShow={({ editor: ed }) => ed.isEditable && !ed.state.selection.empty}>
                    <div className="flex items-center gap-0.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-1 shadow-xl">
                        <Btn active={editor.isActive('bold')} onClick={() => editor.chain().toggleBold().run()} title="Bold"><Bold className="w-3.5 h-3.5" /></Btn>
                        <Btn active={editor.isActive('italic')} onClick={() => editor.chain().toggleItalic().run()} title="Italic"><Italic className="w-3.5 h-3.5" /></Btn>
                        <Btn active={editor.isActive('underline')} onClick={() => editor.chain().toggleUnderline().run()} title="Underline"><UnderlineIcon className="w-3.5 h-3.5" /></Btn>
                        <Btn active={editor.isActive('strike')} onClick={() => editor.chain().toggleStrike().run()} title="Strike"><Strikethrough className="w-3.5 h-3.5" /></Btn>
                        <Btn active={editor.isActive('code')} onClick={() => editor.chain().toggleCode().run()} title="Code"><Code className="w-3.5 h-3.5" /></Btn>
                        <div className="w-px h-4 bg-[#2a2a2a] mx-0.5" />
                        <Btn active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().toggleHeading({ level: 1 }).run()} title="H1"><Heading1 className="w-3.5 h-3.5" /></Btn>
                        <Btn active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().toggleHeading({ level: 2 }).run()} title="H2"><Heading2 className="w-3.5 h-3.5" /></Btn>
                        <Btn active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().toggleHeading({ level: 3 }).run()} title="H3"><Heading3 className="w-3.5 h-3.5" /></Btn>
                        <div className="w-px h-4 bg-[#2a2a2a] mx-0.5" />
                        <Btn active={editor.isActive('bulletList')} onClick={() => editor.chain().toggleBulletList().run()} title="Bullet list"><List className="w-3.5 h-3.5" /></Btn>
                        <Btn active={editor.isActive('orderedList')} onClick={() => editor.chain().toggleOrderedList().run()} title="Numbered list"><ListOrdered className="w-3.5 h-3.5" /></Btn>
                        <Btn active={editor.isActive('taskList')} onClick={() => editor.chain().toggleTaskList().run()} title="Task list"><CheckSquare className="w-3.5 h-3.5" /></Btn>
                        <div className="w-px h-4 bg-[#2a2a2a] mx-0.5" />
                        <Btn active={editor.isActive('link')} title="Link" onClick={() => {
                            if (editor.isActive('link')) { editor.chain().unsetLink().run() }
                            else { const url = window.prompt('URL'); if (url) editor.chain().setLink({ href: url }).run() }
                        }}><Link2 className="w-3.5 h-3.5" /></Btn>
                    </div>
                </BubbleMenu>
            )}

            {isLocked && (
                <div className="flex items-center gap-1.5 text-xs text-amber-500/70 mb-3 select-none">
                    <Lock className="w-3.5 h-3.5" /><span>Locked — read only</span>
                </div>
            )}

            <EditorContent
                editor={editor}
                className={cn(
                    'text-sm text-foreground/80 leading-relaxed rounded-lg transition-all',
                    !isLocked ? 'cursor-pointer hover:bg-[#111]/50 px-1 py-0.5 -mx-1' : 'opacity-70 cursor-default',
                    '[&_.ProseMirror]:outline-none',
                    '[&_.ProseMirror_h1]:text-xl [&_.ProseMirror_h1]:font-bold [&_.ProseMirror_h1]:mt-3 [&_.ProseMirror_h1]:mb-1',
                    '[&_.ProseMirror_h2]:text-lg [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h2]:mt-2 [&_.ProseMirror_h2]:mb-1',
                    '[&_.ProseMirror_h3]:text-base [&_.ProseMirror_h3]:font-medium [&_.ProseMirror_h3]:mt-2',
                    '[&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-5 [&_.ProseMirror_ul]:my-1',
                    '[&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-5 [&_.ProseMirror_ol]:my-1',
                    '[&_.ProseMirror_li]:my-0.5',
                    '[&_.ProseMirror_code]:bg-[#1a1a1a] [&_.ProseMirror_code]:px-1 [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:text-xs [&_.ProseMirror_code]:font-mono',
                    '[&_.ProseMirror_pre]:bg-[#1a1a1a] [&_.ProseMirror_pre]:border [&_.ProseMirror_pre]:border-[#2a2a2a] [&_.ProseMirror_pre]:rounded-md [&_.ProseMirror_pre]:p-3 [&_.ProseMirror_pre]:my-2',
                    '[&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-primary/30 [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_blockquote]:text-muted-foreground/70',
                    '[&_.ProseMirror_a]:text-primary [&_.ProseMirror_a]:underline',
                    '[&_.mention]:bg-primary/10 [&_.mention]:text-primary [&_.mention]:rounded [&_.mention]:px-1 [&_.mention]:text-xs',
                )}
            />
            {editor.isEditable && (
                <p className="text-[10px] text-muted-foreground/30 mt-1 select-none">Auto-saves · Esc to cancel</p>
            )}
        </div>
    )
}

function Btn({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
    return (
        <button type="button" onMouseDown={e => { e.preventDefault(); onClick() }} title={title}
            className={cn('p-1.5 rounded transition-colors', active ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-[#2a2a2a] hover:text-foreground')}>
            {children}
        </button>
    )
}
