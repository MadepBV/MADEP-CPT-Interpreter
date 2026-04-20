export function getLegacy(): Record<string, any> {
	return window as unknown as Record<string, any>;
}

export function call(name: string, ...args: any[]) {
	return getLegacy()[name]?.(...args);
}
