/**
 * Did `agent.model` actually MOVE, or is this just another read of the same
 * value?
 *
 * The pill re-reads config every fifteen seconds because several things can
 * write that setting and none of them can tell this component. That poll is
 * therefore the only place in the app that can notice a switch — but it sees
 * the same value over and over, so "changed" has to be decided rather than
 * assumed.
 *
 * A first read is not a switch. On mount the previous value is empty and the
 * incoming one is whatever was already true; treating that as a change would
 * wipe the rate-limit banner and the context readout on every page load,
 * including the load that happens right after a real limit was hit.
 */
export function isModelSwitch(previous: string, next: string): boolean {
  if (!previous || !next) return false;
  return previous !== next;
}
