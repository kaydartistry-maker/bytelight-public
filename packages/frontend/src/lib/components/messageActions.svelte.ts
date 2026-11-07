import { apiFetch } from '$lib/utils/api';

// Edit / delete / regenerate for one message. MessageBubble renders the
// buttons, MessageActionModals renders the dialogs; both read this state.
export class MessageActions {
  showEditModal = $state(false);
  showDeleteConfirm = $state(false);
  editValue = $state('');
  actionPending = $state(false);
  rerollPreview = $state<{ count: number; revision: string } | null>(null);
  rerollError = $state('');

  // Port 8beeee4e: confirmation comes before the destructive request.
  previewRegenerate = async () => {
    if (this.actionPending) return;
    this.actionPending = true;
    this.rerollError = '';
    try {
      const res = await apiFetch(`/api/messages/${this.message.id}/regenerate-preview`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not preview reroll');
      this.rerollPreview = data;
    } catch (err) {
      this.rerollError = err instanceof Error ? err.message : 'Could not preview reroll';
    } finally { this.actionPending = false; }
  };

  openEditModal = () => {
    this.editValue = this.message.content;
    this.showEditModal = true;
  };

  patchMessage = async (rerun: boolean) => {
    if (this.actionPending || !this.editValue.trim()) return;
    this.actionPending = true;
    try {
      const res = await apiFetch(`/api/messages/${this.message.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: this.editValue, rerun }),
      });
      if (!res.ok) console.error('Edit failed', await res.text());
      else this.showEditModal = false;
    } finally {
      this.actionPending = false;
    }
  };

  deleteMessage = async () => {
    if (this.actionPending) return;
    this.actionPending = true;
    try {
      const res = await apiFetch(`/api/messages/${this.message.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) console.error('Delete failed', await res.text());
      else this.showDeleteConfirm = false;
    } finally {
      this.actionPending = false;
    }
  };

  regenerateMessage = async () => {
    if (this.actionPending || !this.rerollPreview) return;
    const revision = this.rerollPreview.revision;
    this.rerollPreview = null;
    this.actionPending = true;
    try {
      const res = await apiFetch(`/api/messages/${this.message.id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Reroll failed');
      }
    } catch (err) {
      this.rerollError = err instanceof Error ? err.message : 'Reroll failed';
    } finally {
      this.actionPending = false;
    }
  };

  constructor(private getMessage: () => { id: string; content: string }) {}

  private get message() {
    return this.getMessage();
  }
}
