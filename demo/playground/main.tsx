// The demo page. With no query it shows the Dunebot scene; ?capture=<name>
// is the route scripts/film.mjs films (native timers, no viewer around it).
const params = new URLSearchParams(location.search)
const { mount } = await import('./preview')
await mount(params.get('capture') ?? 'dunebot', params.get('still') === '1')

export {}
