// The one place the UI names a unit of work. "Chat" while Olmo is the only
// employee (one assistant = a conversation); "Task" is the likely word once
// several employees work in parallel. Change it here, not across components.
export const WORK_ITEM = {
    singular: "Chat",
    plural: "Chats",
    new: "New chat",
    untitled: "Untitled chat",
    start: "Start a chat…",
    empty: "No chats yet",
    all: "All chats",
} as const;
