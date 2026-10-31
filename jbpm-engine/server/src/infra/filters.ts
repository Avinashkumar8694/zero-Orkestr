// A filter value may be one value or a comma-separated list ("created,reserved"): matches when `actual` is any of them.
// An empty/undefined filter matches everything. Used so that a multi-select in the UI never silently matches nothing.
export const inList = (value: string | undefined, actual: string): boolean => !value || value.split(',').map((x) => x.trim()).filter(Boolean).includes(actual);
