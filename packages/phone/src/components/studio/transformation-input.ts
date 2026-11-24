export type TransformationKind = 'face-transplant' | 'smash';
export interface TransformationUpload { token: string; name: string; preview: string }

export function transformationInput(kind: TransformationKind, slots: Array<TransformationUpload | null>, imageModelId: string, additionalEdits = '', faceAssignments = '') {
  if (!slots[0]?.token || !slots[1]?.token) throw new Error('Add Image 1 and Image 2 before generating.');
  if (kind === 'smash' && slots[2]) throw new Error('Smash & Mash uses exactly two images.');
  if (kind === 'face-transplant' && slots[2] && !faceAssignments.trim()) throw new Error('Specify which character receives each face in Face assignments.');
  if (additionalEdits.length > 4000 || faceAssignments.length > 1000) throw new Error('The editing instructions are too long.');
  return {
    kind,
    images: slots.slice(0, kind === 'smash' ? 2 : 3).filter((x): x is TransformationUpload => x !== null).map(x => x.token),
    imageModelId,
    ...(kind === 'face-transplant' ? { additionalEdits: additionalEdits.trim(), faceAssignments: faceAssignments.trim() } : {}),
  };
}
