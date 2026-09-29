/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), useParams: () => ({ tenant: 'acme' }) }));

const mockUseOfficialSkill = vi.fn();
vi.mock('@/components/platform/skills/useOfficialSkill', () => ({
  useOfficialSkill: (slug: string) => mockUseOfficialSkill(slug),
}));

vi.mock('@/lib/api', () => ({ api: { post: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { api } from '@/lib/api';
import { CREATE_AVATAR_PROMPT, NewAvatarButton } from './NewAvatarButton';

describe('NewAvatarButton', () => {
  beforeEach(() => {
    push.mockClear();
    mockUseOfficialSkill.mockReset();
    vi.mocked(api.post).mockReset();
  });

  it('offers upload and create-with-AI', async () => {
    mockUseOfficialSkill.mockReturnValue(undefined);
    const onUpload = vi.fn();
    const user = userEvent.setup();
    render(<NewAvatarButton onUpload={onUpload} />);
    await user.click(screen.getByRole('button', { name: /new avatar/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /upload photo/i }));
    expect(onUpload).toHaveBeenCalled();
  });

  it('falls back to plain prompt navigation when the Official skill is unavailable (not seeded)', async () => {
    mockUseOfficialSkill.mockReturnValue(undefined);
    const user = userEvent.setup();
    render(<NewAvatarButton onUpload={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /new avatar/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /create with ai/i }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/acme/dashboard/chat?prompt=${encodeURIComponent(CREATE_AVATAR_PROMPT)}`)
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it('installs the Official skill and navigates with &skill= when it is available', async () => {
    mockUseOfficialSkill.mockReturnValue({
      id: 'skill-1',
      name: 'Avatar Creator',
      showcase: { imageUrl: '/creative/avatars/beginner-fitness-instructor.jpg', bestFor: [], starterPrompt: 'Create an avatar' },
    });
    vi.mocked(api.post).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<NewAvatarButton onUpload={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /new avatar/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /create with ai/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/skills/skill-1/install'));
    expect(push).toHaveBeenCalledWith(
      `/acme/dashboard/chat?prompt=${encodeURIComponent('Create an avatar')}&skill=skill-1&skillName=${encodeURIComponent('Avatar Creator')}`
    );
  });
});
