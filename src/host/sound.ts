/**
 * Where the rule scripts' sound requests go.
 *
 * Commander Wars' scripts say what should be heard — a walk sets its engine
 * noise on the walking animation, an explosion names its blast, loading a
 * transport plays a clunk. The host used to swallow all of it.
 *
 * The sink is null unless something is listening, and the app only listens
 * while it performs an action the person at the screen may witness. That is
 * the whole gate: an AI searching ahead runs thousands of actions that must be
 * silent, and so must a move made in the fog.
 */
export const soundBus: { sink: ((file: string) => void) | null } = { sink: null };

export function requestSound(file: unknown): void {
  if (typeof file === 'string' && file !== '') soundBus.sink?.(file);
}
