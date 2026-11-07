import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { ThemeConfig } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { apiFetch } from '../../bytelight';

const CC_API = '/api/cc';

interface CcSubPageProps {
  themeConfig: ThemeConfig;
  themeMode: 'light' | 'dark';
}

function petAge(birthday: string): string {
  if (!birthday) return '';
  const years = Math.floor((Date.now() - new Date(birthday).getTime()) / (365.25 * 86400000));
  return years > 0 ? `${years}y` : '<1y';
}

const EMPTY = { name: '', species: '', breed: '', birthday: '', weight: '', notes: '' };

export function CcPets({ themeConfig, themeMode }: CcSubPageProps) {
  const colors = themeConfig[themeMode];
  const [loading, setLoading] = useState(true);
  const [pets, setPets] = useState<any[]>([]);
  const [upcoming, setUpcoming] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editingPet, setEditingPet] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY });

  async function load() {
    try {
      const [pRes, uRes] = await Promise.all([
        apiFetch(`${CC_API}/pets`),
        apiFetch(`${CC_API}/pets/upcoming?days=14`),
      ]);
      setPets((await pRes.json()).pets || []);
      setUpcoming((await uRes.json()).items || []);
    } catch {
      /* empty */
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function set(key: keyof typeof EMPTY, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function addPet() {
    if (!form.name.trim()) return;
    await apiFetch(`${CC_API}/pets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name.trim(),
        species: form.species || undefined,
        breed: form.breed || undefined,
        birthday: form.birthday || undefined,
      }),
    });
    setForm({ ...EMPTY });
    setShowAdd(false);
    await load();
  }

  async function savePetEdit() {
    if (!editingPet || !form.name.trim()) return;
    await apiFetch(`${CC_API}/pets/${editingPet}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name.trim(),
        species: form.species || undefined,
        breed: form.breed || undefined,
        birthday: form.birthday || undefined,
        weight: form.weight || undefined,
        notes: form.notes || undefined,
      }),
    });
    setEditingPet(null);
    setForm({ ...EMPTY });
    await load();
  }

  async function markGiven(item: any) {
    await apiFetch(`${CC_API}/pets/medications/given`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ med_name: item.name, pet_name: item.pet }),
    });
    await load();
  }

  const card = cn('rounded-2xl border p-3 mb-3', colors.panelBg, colors.panelBorder);
  const input = cn('rounded-lg border px-3 py-2 text-sm bg-transparent w-full', colors.panelBorder, colors.textMain);

  function petForm(onSubmit: () => void, onCancel?: () => void) {
    return (
      <div className="flex flex-col gap-2">
        <input className={input} placeholder="Pet name" value={form.name} onChange={(e) => set('name', e.target.value)} />
        <div className="flex gap-2">
          <input className={input} placeholder="Species" value={form.species} onChange={(e) => set('species', e.target.value)} />
          <input className={input} placeholder="Breed" value={form.breed} onChange={(e) => set('breed', e.target.value)} />
        </div>
        <div className="flex gap-2">
          <input className={input} type="date" value={form.birthday} onChange={(e) => set('birthday', e.target.value)} />
          {editingPet && (
            <input className={input} placeholder="Weight" value={form.weight} onChange={(e) => set('weight', e.target.value)} />
          )}
        </div>
        {editingPet && (
          <input className={input} placeholder="Notes" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        )}
        <div className="flex gap-2">
          <button onClick={onSubmit} className="rounded-lg px-4 py-2 text-sm font-semibold bytelight-on-accent" style={{ background: colors.accent }}>
            {editingPet ? 'Save' : 'Add'}
          </button>
          {onCancel && (
            <button onClick={onCancel} className={cn('px-3 py-2 text-sm', colors.textMuted)}>Cancel</button>
          )}
        </div>
      </div>
    );
  }

  if (loading) return <div className={cn('rounded-2xl border p-3 backdrop-blur-md text-xs py-6 text-center', colors.panelBg, colors.panelBorder, colors.textMuted)}>Loading…</div>;

  return (
    <>
      {upcoming.length > 0 && (
        <div className={card} style={{ borderColor: upcoming.some((u) => u.overdue) ? colors.accent : undefined }}>
          <div className={cn('text-[11px] font-bold uppercase tracking-[0.12em] mb-2', colors.textMuted)}>Upcoming care</div>
          {upcoming.map((item, i) => (
            <div key={i} className="flex items-center justify-between gap-2 py-1.5">
              <div className="min-w-0">
                <span className={cn('text-sm font-semibold', colors.textMain)}>{item.pet}</span>
                <span className={cn('text-xs ml-1', colors.textMuted)}>
                  {item.name} ({item.type === 'medication' ? item.frequency : item.event_type})
                </span>
                <div className="text-[11px]" style={{ color: item.overdue ? colors.accent : undefined, opacity: item.overdue ? 0.9 : 1 }}>
                  {item.overdue ? 'Overdue' : item.isToday ? 'Today' : item.due}
                </div>
              </div>
              {item.type === 'medication' && (
                <button
                  onClick={() => markGiven(item)}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold bytelight-on-accent shrink-0"
                  style={{ background: colors.accent }}
                >
                  Done
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className={cn('rounded-2xl border p-3 backdrop-blur-md', colors.panelBg, colors.panelBorder)}>
        <div className="flex items-center justify-between mb-2">
          <span className={cn('text-[11px] font-bold uppercase tracking-[0.12em]', colors.textMuted)}>Pets</span>
          <button
            onClick={() => { setShowAdd(!showAdd); setForm({ ...EMPTY }); }}
            className="rounded-full p-1.5 bytelight-on-accent"
            style={{ background: colors.accent }}
          >
            <Plus size={14} />
          </button>
        </div>

        {showAdd && <div className="mb-3">{petForm(addPet)}</div>}

        {pets.length === 0 && !showAdd ? (
          <div className={cn('text-xs py-6 text-center', colors.textMuted)}>No pets added yet.</div>
        ) : (
          <div className="space-y-2">
          {pets.map((pet) => (
            <div key={pet.id} className={cn('rounded-xl border p-3', colors.panelBorder)}>
              {editingPet === pet.id ? (
                petForm(savePetEdit, () => { setEditingPet(null); setForm({ ...EMPTY }); })
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex items-baseline gap-2">
                      <span className={cn('text-base font-semibold', colors.textMain)}>{pet.name}</span>
                      {pet.birthday && <span className={cn('text-xs', colors.textMuted)}>{petAge(pet.birthday)}</span>}
                    </div>
                    <button
                      onClick={() => {
                        setEditingPet(pet.id);
                        setForm({
                          name: pet.name || '',
                          species: pet.species || '',
                          breed: pet.breed || '',
                          birthday: pet.birthday || '',
                          weight: pet.weight || '',
                          notes: pet.notes || '',
                        });
                      }}
                      className={cn('rounded-lg border px-3 py-1 text-xs', colors.panelBorder, colors.textMain)}
                    >
                      Edit
                    </button>
                  </div>
                  {(pet.species || pet.breed || pet.weight) && (
                    <div className={cn('text-xs mt-1', colors.textMuted)}>
                      {[pet.species, pet.breed, pet.weight].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {pet.notes && <p className={cn('text-xs mt-1.5', colors.textMuted)}>{pet.notes}</p>}
                </>
              )}
            </div>
          ))}
          </div>
        )}
      </div>
    </>
  );
}
