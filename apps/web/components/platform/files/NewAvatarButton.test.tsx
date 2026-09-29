/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), useParams: () => ({ tenant: 'acme' }) }));
import { CREATE_AVATAR_PROMPT, NewAvatarButton } from './NewAvatarButton';

describe('NewAvatarButton', () => {
  it('offers upload and create-with-AI', async () => {
    const onUpload = vi.fn();
    const user = userEvent.setup();
    render(<NewAvatarButton onUpload={onUpload} />);
    await user.click(screen.getByRole('button', { name: /new avatar/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /upload photo/i }));
    expect(onUpload).toHaveBeenCalled();
  });

  it('opens chat with the create-avatar prompt', async () => {
    const user = userEvent.setup();
    render(<NewAvatarButton onUpload={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /new avatar/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /create with ai/i }));
    expect(push).toHaveBeenCalledWith(`/acme/dashboard/chat?prompt=${encodeURIComponent(CREATE_AVATAR_PROMPT)}`);
  });
});
