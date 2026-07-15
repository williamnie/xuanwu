/**
 * @typedef {RequestInit & {headers?: HeadersInit}} ApiRequestOptions
 *
 * @typedef {Object} ApiEventSubscriber
 * @property {(data: unknown) => void} [onEvent]
 * @property {(error: Event) => void} [onError]
 * @property {() => void} [onOpen]
 *
 * @typedef {Object} EventSummaryFilter
 * @property {string|number} [afterId]
 * @property {string|number} [beforeId]
 * @property {string[]} [excludeTypes]
 * @property {number} [limit]
 * @property {string} [projectId]
 * @property {string[]} [types]
 */

export {};
