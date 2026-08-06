import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createDefaultState } from "./seed.js";
import type { JiraState } from "./types.js";

export class JiraStore {
  readonly dataFile: string;
  state: JiraState;

  constructor(dataFile: string) {
    this.dataFile = dataFile;
    this.state = this.load();
  }

  private load(): JiraState {
    if (!existsSync(this.dataFile)) {
      const state = createDefaultState();
      this.persist(state);
      return state;
    }

    try {
      return JSON.parse(readFileSync(this.dataFile, "utf8")) as JiraState;
    } catch (error) {
      throw new Error(`Unable to read Jira mock state at ${this.dataFile}`, { cause: error });
    }
  }

  save(): void {
    this.persist(this.state);
  }

  reset(): void {
    this.state = createDefaultState();
    this.save();
  }

  private persist(state: JiraState): void {
    mkdirSync(dirname(this.dataFile), { recursive: true });
    const temporaryFile = `${this.dataFile}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temporaryFile, this.dataFile);
  }
}
