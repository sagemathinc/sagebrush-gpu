// The provider-side name of a machine carries our machine id, so the watchdog and orphan
// recovery can map provider machines to ledger rows. Anything that doesn't parse isn't ours.

import { isId, type MachineId } from "@sbgpu/api";

const PREFIX = "sbg-";

export function machineName(machineId: MachineId): string {
  if (!isId("machine", machineId)) throw new RangeError(`not a machine id: ${machineId}`);
  return PREFIX + machineId;
}

export function parseMachineName(name: string): MachineId | null {
  if (!name.startsWith(PREFIX)) return null;
  const id = name.slice(PREFIX.length);
  return isId("machine", id) ? id : null;
}
