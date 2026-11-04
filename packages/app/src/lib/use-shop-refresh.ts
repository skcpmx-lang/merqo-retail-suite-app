import { useEffect, useRef } from 'react';
import { shopQueries, type ShopQueryKey } from './shop-events.js';

/**
 * Re-runs `refresh` when a shop event invalidates `keys`.
 *
 * Screens keep their own loading code — this only decides *when* to run it, so no data
 * or business logic moves into the event layer. The callback is re-read on every render,
 * so it always sees the current filters and pagination.
 */
export function useShopRefresh(keys: ShopQueryKey | ShopQueryKey[], refresh: () => void | Promise<void>): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  const list = Array.isArray(keys) ? keys : [keys];
  const key = list.join('|');
  useEffect(() => {
    const offs = list.map((k) =>
      shopQueries.register(k, () => {
        void latest.current();
      }),
    );
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
