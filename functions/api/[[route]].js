// Every /api/* request on the site's origin goes to the worker (worker/pages.js).
export { onRequest } from '../../worker/pages.js';
