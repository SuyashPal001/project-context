import { describe, it, expect } from 'vitest';
import { greetingName } from './greetingName';

// The greeting reads "Hi {name}!", so an empty result would render "Hi !".
// Claims come from the Cognito ID token: Google-federated logins carry
// given_name/name, but a plain email signup may carry neither.
describe('greetingName', () => {
    it('prefers given_name', () => {
        expect(greetingName({ given_name: 'Suyash', name: 'Suyash Pal', email: 'x@y.com' })).toBe('Suyash');
    });

    it('falls back to the first word of the full name', () => {
        expect(greetingName({ name: 'Suyash Pal', email: 'x@y.com' })).toBe('Suyash');
    });

    it('falls back to the email local part, capitalised', () => {
        expect(greetingName({ email: 'suyash@example.com' })).toBe('Suyash');
    });

    it('stops the email fallback at a separator rather than greeting "John.doe"', () => {
        expect(greetingName({ email: 'john.doe@example.com' })).toBe('John');
        expect(greetingName({ email: 'john_doe@example.com' })).toBe('John');
        expect(greetingName({ email: 'john+tag@example.com' })).toBe('John');
    });

    it('says "there" when the token carries no identity at all', () => {
        expect(greetingName({})).toBe('there');
    });

    it('ignores blank claims rather than greeting an empty string', () => {
        expect(greetingName({ given_name: '  ', name: '', email: 'suyash@example.com' })).toBe('Suyash');
        expect(greetingName({ given_name: '', name: '', email: '' })).toBe('there');
    });
});
