/** @vitest-environment jsdom */
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('thinking-orbs', () => ({ ThinkingOrb: ({ state }: { state: string }) => <span data-testid="orb">{state}</span> }));
import { StepList, groupSteps } from './StepList';
import type { LiveStep } from './types';

afterEach(() => cleanup());
const step = (id: string, key: string, label: string, kind: LiveStep['kind'], state: LiveStep['state'], count = 1): LiveStep => ({ id, key, label, kind, state, count });

describe('StepList', () => {
    const steps = [
        step('1', 'storyboard', 'Storyboard', 'image', 'done'),
        step('2', 'clips', 'Video clips', 'video', 'done'),
        step('3', 'voice', 'Voice', 'voice', 'done'),
        step('4', 'voice', 'Voice', 'voice', 'running'),
        step('5', 'voice', 'Voice', 'voice', 'running'),
        step('6', 'checks', 'Quality checks', 'check', 'failed'),
    ];
    it('groups calls into one row per step, in the order they started', () => {
        expect(groupSteps(steps).map(r => [r.label, r.done, r.total, r.running])).toEqual([
            ['Storyboard', 1, 1, false], ['Video clips', 1, 1, false], ['Voice', 1, 3, true], ['Quality checks', 0, 1, false],
        ]);
    });
    it('animates only the running row, with the orb for its kind of work', () => {
        render(<StepList steps={steps} />);
        expect(screen.getAllByTestId('orb').map(o => o.textContent)).toEqual(['listening']);
        expect(screen.getByText('1 of 3')).toBeTruthy();
        expect(screen.getByText('needs a look')).toBeTruthy();
    });
    it('shows no animation once the turn is over', () => {
        render(<StepList steps={steps} live={false} />);
        expect(screen.queryByTestId('orb')).toBeNull();
    });
    it('says when a step waits for your OK, was skipped or needs credits', () => {
        render(<StepList steps={[
            step('a', 'pictures', 'Pictures', 'image', 'waiting'),
            step('b', 'clips', 'Video clips', 'video', 'skipped'),
            step('c', 'voice', 'Voice', 'voice', 'credits'),
        ]} />);
        expect(screen.queryByTestId('orb')).toBeNull();
        expect(screen.getByText('waiting for your OK')).toBeTruthy();
        expect(screen.getByText('skipped')).toBeTruthy();
        expect(screen.getByText('needs credits')).toBeTruthy();
    });
});
