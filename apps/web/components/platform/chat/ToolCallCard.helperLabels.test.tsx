/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ToolCallCard, skillDisplayName } from './ToolCallCard';

afterEach(() => cleanup());

describe('ToolCallCard — helper tool labels', () => {
    it('names the loaded skill in plain words', () => {
        render(<ToolCallCard toolName="skill" query="avatar-creator" status="done" />);
        expect(screen.getByText('Loaded skill')).toBeTruthy();
        expect(screen.getByText('— Avatar creator', { exact: false })).toBeTruthy();
        expect(screen.queryByText(/avatar-creator/)).toBeNull();
    });

    it('gives each helper its own wording instead of "Used <tool name>"', () => {
        render(<ToolCallCard toolName="check_credit_plan" query="" status="done" />);
        expect(screen.getByText('Checked your credits')).toBeTruthy();
        cleanup();
        render(<ToolCallCard toolName="ask_clarifying_questions" query="" status="loading" />);
        expect(screen.getByText('Preparing a few questions')).toBeTruthy();
        expect(screen.queryByText(/Using|Used/)).toBeNull();
    });

    it('still falls back to "Used <tool>" for tools it does not know', () => {
        render(<ToolCallCard toolName="some_new_tool" query="" status="done" />);
        expect(screen.getByText('Used some new tool')).toBeTruthy();
    });

    it('turns a skill slug into a display name', () => {
        expect(skillDisplayName('tvc-character-creator')).toBe('TVC character creator');
        expect(skillDisplayName('')).toBe('');
    });
});
