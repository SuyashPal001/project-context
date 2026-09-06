import { describe, it, expect, vi } from 'vitest';
import { resolvePills } from './WelcomeView';
import type { Agent } from '../agents/types';

function makeAgent(overrides: Partial<Agent>): Agent {
    return {
        id: 'a1', tenantId: 't1', name: 'Test Agent', type: 'custom', status: 'active',
        model: null, llmProviderId: null, isInternal: false, isDefault: false,
        description: null, persona: null, avatarUrl: null, createdAt: new Date().toISOString(),
        ...overrides,
    };
}

describe('resolvePills', () => {
    it('returns the hardcoded PM wizard pills when persona.slug is "pm"', () => {
        const agent = makeAgent({ persona: { id: 'p1', slug: 'pm', name: 'PM', tagline: '', category: 'product', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: null } });
        const pills = resolvePills(agent);
        expect(pills.map(p => p.label)).toEqual(['Write a PRD', 'Build a roadmap', 'Break into tasks', 'Research a topic']);
    });

    it('returns the hardcoded Director pills when persona.slug is "director", ignoring any suggestedPrompts', () => {
        const agent = makeAgent({ persona: { id: 'p2', slug: 'director', name: 'Director', tagline: '', category: 'product', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: [{ icon: 'sparkles', label: 'Should be ignored', promptText: 'x' }] } });
        const pills = resolvePills(agent);
        expect(pills.map(p => p.label)).toEqual(['Generate an image', 'Create a logo', 'Design a banner', 'Illustrate an idea']);
    });

    it('returns the persona\'s own suggestedPrompts when present and not PM/Director', () => {
        const agent = makeAgent({
            type: 'custom',
            persona: { id: 'p3', slug: 'producer', name: 'Producer', tagline: '', category: 'product', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: [
                { icon: 'music', label: 'Make a beat', promptText: 'Make a lofi beat about ' },
                { icon: 'music', label: 'Remix a track', promptText: 'Remix this track: ' },
            ] },
        });
        const pills = resolvePills(agent);
        expect(pills.map(p => p.label)).toEqual(['Make a beat', 'Remix a track']);
    });

    it('falls through to the per-type table when persona.suggestedPrompts has fewer than 2 items', () => {
        const agent = makeAgent({
            type: 'billing',
            persona: { id: 'p4', slug: 'some-new-persona', name: 'New', tagline: '', category: 'product', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: [{ icon: 'sparkles', label: 'Only one', promptText: 'x' }] },
        });
        const pills = resolvePills(agent);
        expect(pills.length).toBeGreaterThanOrEqual(2);
        expect(pills.map(p => p.label)).not.toContain('Only one');
    });

    it('falls through to the per-type table for a bare custom-type agent with no persona but a known type', () => {
        const agent = makeAgent({ type: 'billing', persona: null });
        const pills = resolvePills(agent);
        expect(pills.length).toBeGreaterThan(0);
        expect(pills.map(p => p.label)).not.toEqual(['Brainstorm ideas', 'Draft something', 'Research a topic', 'Explain a concept']);
    });

    it('falls all the way through to GENERAL_PROMPTS for a bare custom agent with no persona and type "custom"', () => {
        const agent = makeAgent({ type: 'custom', persona: null });
        const pills = resolvePills(agent);
        expect(pills.map(p => p.label)).toEqual(['Brainstorm ideas', 'Draft something', 'Research a topic', 'Explain a concept']);
    });

    it('slices persona suggestedPrompts to at most 4', () => {
        const agent = makeAgent({
            type: 'custom',
            persona: { id: 'p5', slug: 'five-pills', name: 'Five', tagline: '', category: 'product', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: [
                { icon: 'sparkles', label: 'One', promptText: 'a' },
                { icon: 'sparkles', label: 'Two', promptText: 'b' },
                { icon: 'sparkles', label: 'Three', promptText: 'c' },
                { icon: 'sparkles', label: 'Four', promptText: 'd' },
                { icon: 'sparkles', label: 'Five', promptText: 'e' },
            ] },
        });
        const pills = resolvePills(agent);
        expect(pills.length).toBe(4);
    });

    it('clicking a resolved pill from a plain-text source calls onSend with its promptText', () => {
        const agent = makeAgent({
            type: 'custom',
            persona: { id: 'p6', slug: 'producer2', name: 'Producer', tagline: '', category: 'product', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: [
                { icon: 'music', label: 'Make a beat', promptText: 'Make a lofi beat about ' },
                { icon: 'music', label: 'Remix', promptText: 'Remix ' },
            ] },
        });
        const pills = resolvePills(agent);
        const onSend = vi.fn();
        const onSelectPill = vi.fn();
        pills[0].onClick({ onSend, onSelectPill });
        expect(onSend).toHaveBeenCalledWith('Make a lofi beat about ');
        expect(onSelectPill).not.toHaveBeenCalled();
    });

    it('clicking a PM pill calls onSelectPill, not onSend', () => {
        const agent = makeAgent({ persona: { id: 'p7', slug: 'pm', name: 'PM', tagline: '', category: 'product', skillTags: [], isOfficial: true, exampleAssetUrl: null, exampleCaption: null, exampleAssetUrl2: null, exampleCaption2: null, defaultModel: null, suggestedPrompts: null } });
        const pills = resolvePills(agent);
        const onSend = vi.fn();
        const onSelectPill = vi.fn();
        pills[0].onClick({ onSend, onSelectPill });
        expect(onSelectPill).toHaveBeenCalledWith('prd');
        expect(onSend).not.toHaveBeenCalled();
    });

    it('handles a null agent by returning GENERAL_PROMPTS', () => {
        const pills = resolvePills(null);
        expect(pills.map(p => p.label)).toEqual(['Brainstorm ideas', 'Draft something', 'Research a topic', 'Explain a concept']);
    });
});
