export const kinds = ['person', 'tool', 'model', 'concept', 'article', 'document', 'idea', 'task', 'other'] as const;
export const intentions = ['remember', 'explore', 'act'] as const;
export type Kind = typeof kinds[number];
export type Intention = typeof intentions[number];
