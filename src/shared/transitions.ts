import type { JiraStatus } from "../types.js";

export function availableTransitions(status: JiraStatus, statuses: JiraStatus[]) {
  const byName = (name: string) => statuses.find((candidate) => candidate.name === name)!;
  if (status.name === "To Do") {
    return [{ id: "21", name: "Start Progress", to: byName("In Progress"), hasScreen: false }];
  }
  if (status.name === "In Progress") {
    return [
      { id: "31", name: "Resolve Issue", to: byName("Done"), hasScreen: false },
      { id: "41", name: "Stop Progress", to: byName("To Do"), hasScreen: false },
    ];
  }
  return [{ id: "51", name: "Reopen Issue", to: byName("To Do"), hasScreen: false }];
}
