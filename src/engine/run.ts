export type EngineWorkflowRunner = (args: string[]) => Promise<number>;

/**
 * Thin child-process boundary. The engine owns workflow execution; the parent
 * supervisor owns only liveness, termination and restart policy.
 */
export async function runEngine(args: string[], runner: EngineWorkflowRunner): Promise<number> {
  return runner(args);
}
