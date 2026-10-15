export interface PreviewJob { workDir: string; width: number; height: number; segments: Array<{ seconds: number; start: string | null; end: string | null }> }
export async function renderPreview(_job: PreviewJob): Promise<string> { throw new Error('renderPreview: not built yet') }
