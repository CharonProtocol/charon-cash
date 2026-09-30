export declare function mirrorCacheAvailable(): boolean;
export declare function loadCachedLeaves(treeKey: string): Promise<string[]>;
export declare function saveCachedLeaves(treeKey: string, leaves: string[], changedFrom?: number): Promise<void>;
export declare function clearCachedLeaves(treeKey: string): Promise<void>;
export declare const MIRROR_CACHE_CHUNK_SIZE = 2000;
//# sourceMappingURL=mirror-cache.d.ts.map