// Simplified, single-color logomarks (currentColor) for LLM providers, matching this
// app's no-decorative-color rule — recognizable silhouettes, not full brand assets.

function OpenAIMark(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="none" {...props}>
            <path
                fill="currentColor"
                d="M21.55 10.004a5.416 5.416 0 0 0-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0 0 10.831 1C8.39.995 6.224 2.546 5.473 4.838a5.601 5.601 0 0 0-3.746 2.7c-1.226 2.088-.947 4.712.692 6.5a5.416 5.416 0 0 0 .478 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.59 5.59 0 0 0 13.169 23c2.44.006 4.606-1.546 5.357-3.84a5.6 5.6 0 0 0 3.746-2.699c1.225-2.088.947-4.711-.692-6.499zM13.171 21.478a4.15 4.15 0 0 1-2.669-.964c.034-.018.093-.05.132-.073l4.44-2.56a.72.72 0 0 0 .364-.63v-6.253l1.877 1.083a.067.067 0 0 1 .036.052v5.183c0 2.293-1.86 4.153-4.18 4.162zm-8.99-3.83a4.14 4.14 0 0 1-.497-2.79c.032.02.09.055.13.078l4.44 2.56a.727.727 0 0 0 .729 0l5.42-3.127v2.166a.07.07 0 0 1-.028.058l-4.49 2.59c-2.008 1.15-4.573.463-5.703-1.535zM3.005 8.243a4.14 4.14 0 0 1 2.164-1.822v5.269a.72.72 0 0 0 .364.629l5.42 3.127-1.877 1.083a.067.067 0 0 1-.063.006L4.523 13.94a4.15 4.15 0 0 1-1.518-5.696zm15.417 3.586-5.42-3.127 1.877-1.083a.067.067 0 0 1 .063-.006l4.49 2.594a4.155 4.155 0 0 1-.633 7.508v-5.27a.71.71 0 0 0-.377-.616zm1.868-2.81a5.7 5.7 0 0 0-.13-.078l-4.44-2.56a.72.72 0 0 0-.728 0l-5.42 3.126V7.34a.07.07 0 0 1 .028-.057l4.49-2.588c2.01-1.15 4.579-.46 5.706 1.542a4.14 4.14 0 0 1 .494 2.782zM8.83 12.86l-1.878-1.083a.067.067 0 0 1-.036-.052V6.542c.002-2.296 1.868-4.156 4.19-4.155.976 0 1.92.343 2.664.964-.034.018-.092.05-.132.073l-4.44 2.56a.72.72 0 0 0-.365.63l-.003 6.245zm1.02-2.2 2.415-1.394 2.415 1.393v2.786l-2.415 1.393-2.415-1.393V10.66z"
            />
        </svg>
    );
}

function AnthropicMark(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="none" {...props}>
            <path
                fill="currentColor"
                d="M14.895 3.5h-3.03L17.5 20.5h3.03L14.895 3.5Zm-8.85 0L.51 20.5h3.09l1.185-3.185h6.06L11.03 20.5h3.09L8.685 3.5h-2.64Zm-.06 11.24 2.19-5.905 2.19 5.905H5.985Z"
            />
        </svg>
    );
}

function GeminiMark(props: React.SVGProps<SVGSVGElement>) {
    // A proper 4-point sparkle (N/E/S/W), not just a vertical lens — the
    // previous path had no horizontal spread and read as a thin squeezed
    // sliver at small sizes.
    return (
        <svg viewBox="0 0 24 24" fill="none" {...props}>
            <path
                fill="currentColor"
                d="M12 2c.7 4.2 2.1 7.1 4.6 8.9.8.6 1.7 1 2.7 1.3-1 .3-1.9.7-2.7 1.3-2.5 1.8-3.9 4.7-4.6 8.9-.7-4.2-2.1-7.1-4.6-8.9-.8-.6-1.7-1-2.7-1.3 1-.3 1.9-.7 2.7-1.3C9.9 9.1 11.3 6.2 12 2Z"
            />
        </svg>
    );
}

function MistralMark(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="none" {...props}>
            <path fill="currentColor" d="M3 4h3v3H3V4Zm0 4.5h3v3H3v-3ZM3 13h3v3H3v-3Zm0 4.5h3V21H3v-3.5Z" />
            <path fill="currentColor" d="M9 4h3v3H9V4Zm0 9h3v3H9v-3Z" />
            <path fill="currentColor" d="M15 4h3v3h-3V4Zm0 4.5h3v3h-3v-3Zm0 4.5h3v3h-3v-3Zm0 4.5h3V21h-3v-3.5Z" />
            <path fill="currentColor" d="M21 4h-3v3h3V4Zm0 9h-3v3h3v-3Z" />
        </svg>
    );
}

function GenericModelMark(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="none" {...props}>
            <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.75" />
            <circle cx="12" cy="12" r="2.5" fill="currentColor" />
        </svg>
    );
}

const MARKS: Record<string, (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element> = {
    openai: OpenAIMark,
    anthropic: AnthropicMark,
    vertex: GeminiMark,
    gemini: GeminiMark,
    google: GeminiMark,
    mistral: MistralMark,
};

export function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
    const Mark = MARKS[provider.toLowerCase()] ?? GenericModelMark;
    return <Mark className={className} />;
}
