/** A refusal of the designer, with every reason. */
export class DesignerError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly problems: readonly string[] = []
    ) {
        super(problems.length > 0 ? `${message}:\n- ${problems.join("\n- ")}` : message);
        this.name = "DesignerError";
    }
}
