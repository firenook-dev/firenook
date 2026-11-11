export type Compared = "answer" | "error" | "status" | "verdict" | "behaviour";
export declare const COMPARED: Readonly<{ answer: "answer"; error: "error"; status: "status"; verdict: "verdict"; behaviour: "behaviour" }>;
export declare const enabled: boolean;
export declare function checked(set: string, id: string, compared: Compared): void;
export declare function differs(set: string, id: string, compared: Compared, reason: string): void;
