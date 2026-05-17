// SSE parser
// Accumulates raw bytes across chunk boundaries and emits complete events.
// An SSE event is terminated by a blank line (\n\n or \r\n\r\n).
// Each event may have multiple "field: value" lines; we care about
// "event:" and "data:".

export interface SSEEvent {
    type: string;   // value of the "event:" field, defaults to "message"
    data: string;   // raw value of the last "data:" field
}

export class SSEParser {
    private buffer = '';

    push(chunk: string): SSEEvent[] {
        this.buffer += chunk;
        const events: SSEEvent[] = [];

        const parts = this.buffer.split(/\r?\n\r?\n/);
        this.buffer = parts.pop() ?? '';

        for (const part of parts) {
            const event = this.parseBlock(part.trim());
            if (event) events.push(event);
        }

        return events;
    }

    private parseBlock(block: string): SSEEvent | null {
        if (!block) return null;

        let type = 'message';
        let data = '';

        for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) {
                type = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
                data = line.slice(5).trim();
            }
            // ignore "id:", "retry:", and comment lines (:)
        }

        if (!data) return null;
        return { type, data };
    }

    reset() {
        this.buffer = '';
    }
}
