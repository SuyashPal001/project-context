import { ReactRenderer } from '@tiptap/react'
import tippy, { type Instance } from 'tippy.js'
import type { Editor } from '@tiptap/core'
import { SlashList, type SlashItem } from './SlashList'
import { SLASH_TEMPLATES } from './templates'

// ─── All slash items ──────────────────────────────────────────────────────────

const TEMPLATE_ITEMS: SlashItem[] = SLASH_TEMPLATES.map(t => ({
    id: t.pageType,
    title: t.title,
    description: t.description,
    group: 'template',
}))

const FORMAT_ITEMS: SlashItem[] = [
    { id: 'heading1',    title: 'Heading 1',     description: 'Large section heading', group: 'format' },
    { id: 'heading2',    title: 'Heading 2',     description: 'Medium section heading', group: 'format' },
    { id: 'heading3',    title: 'Heading 3',     description: 'Small section heading', group: 'format' },
    { id: 'bulletList',  title: 'Bullet List',   description: 'Unordered list', group: 'format' },
    { id: 'orderedList', title: 'Numbered List', description: 'Ordered list', group: 'format' },
    { id: 'taskList',    title: 'Task List',     description: 'Checklist items', group: 'format' },
    { id: 'codeBlock',   title: 'Code Block',    description: 'Syntax highlighted code', group: 'format' },
    { id: 'blockquote',  title: 'Blockquote',    description: 'Indented quote', group: 'format' },
    { id: 'divider',     title: 'Divider',       description: 'Horizontal rule', group: 'format' },
]

const ALL_ITEMS: SlashItem[] = [...TEMPLATE_ITEMS, ...FORMAT_ITEMS]

// ─── Execute command ──────────────────────────────────────────────────────────

function executeSlashItem(editor: Editor, item: SlashItem): void {
    if (item.group === 'template') {
        const template = SLASH_TEMPLATES.find(t => t.pageType === item.id)
        if (template) {
            editor.chain().focus().insertContent(template.html).run()
        }
        return
    }

    const chain = editor.chain().focus()
    switch (item.id) {
        case 'heading1':    chain.toggleHeading({ level: 1 }).run(); break
        case 'heading2':    chain.toggleHeading({ level: 2 }).run(); break
        case 'heading3':    chain.toggleHeading({ level: 3 }).run(); break
        case 'bulletList':  chain.toggleBulletList().run(); break
        case 'orderedList': chain.toggleOrderedList().run(); break
        case 'taskList':    chain.toggleTaskList().run(); break
        case 'codeBlock':   chain.toggleCodeBlock().run(); break
        case 'blockquote':  chain.toggleBlockquote().run(); break
        case 'divider':     chain.setHorizontalRule().run(); break
    }
}

// ─── Suggestion config ────────────────────────────────────────────────────────

export function createSlashSuggestion() {
    return {
        char: '/',
        allowSpaces: false,
        startOfLine: false,

        items: ({ query }: { query: string }): SlashItem[] => {
            const q = query.toLowerCase()
            if (!q) return ALL_ITEMS
            return ALL_ITEMS.filter(
                i => i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
            )
        },

        render: () => {
            let component: ReactRenderer
            let popup: Instance[]

            return {
                onStart: (props: Record<string, unknown>) => {
                    component = new ReactRenderer(SlashList, {
                        props: {
                            ...props,
                            command: (item: SlashItem) => {
                                ;(props.command as (p: { id: string }) => void)({ id: item.id })
                            },
                        },
                        editor: props.editor as Editor,
                    })

                    if (!props.clientRect) return

                    popup = tippy('body', {
                        getReferenceClientRect: props.clientRect as () => DOMRect,
                        appendTo: () => document.body,
                        content: component.element,
                        showOnCreate: true,
                        interactive: true,
                        trigger: 'manual',
                        placement: 'bottom-start',
                        theme: 'none',
                        arrow: false,
                        offset: [0, 4],
                        zIndex: 9999,
                    }) as Instance[]
                },

                onUpdate: (props: Record<string, unknown>) => {
                    component.updateProps({
                        ...props,
                        command: (item: SlashItem) => {
                            ;(props.command as (p: { id: string }) => void)({ id: item.id })
                        },
                    })
                    if (!props.clientRect) return
                    popup?.[0]?.setProps({ getReferenceClientRect: props.clientRect as () => DOMRect })
                },

                onKeyDown: (props: { event: KeyboardEvent }) => {
                    if (props.event.key === 'Escape') {
                        // stopImmediatePropagation so the PageEditor's document listener
                        // doesn't also receive this Escape and exit edit mode
                        props.event.stopImmediatePropagation()
                        popup?.[0]?.hide()
                        return true
                    }
                    return (component.ref as { onKeyDown?: (p: { event: KeyboardEvent }) => boolean })?.onKeyDown?.(props) ?? false
                },

                onExit: () => {
                    popup?.[0]?.destroy()
                    component?.destroy()
                },
            }
        },

        command: ({ editor, range, props }: { editor: Editor; range: { from: number; to: number }; props: { id: string } }) => {
            // Delete the slash trigger text first
            editor.chain().focus().deleteRange(range).run()
            const item = ALL_ITEMS.find(i => i.id === props.id)
            if (item) executeSlashItem(editor, item)
        },
    }
}
