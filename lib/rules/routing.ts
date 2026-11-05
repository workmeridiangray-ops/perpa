export const PUBLIC_PATHS = ["/", "/login"];
export const isPublicPath = (p: string): boolean => PUBLIC_PATHS.includes(p);
