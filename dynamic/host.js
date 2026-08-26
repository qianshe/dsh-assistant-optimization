// dsh-assistant-optimization — Dynamic Host half
// thinking-tags RPC via harness.handle (Package-private Client→Host)

var DEFAULT_MARKERS = ['</think>']
var markers = [...DEFAULT_MARKERS]

return {
  apply(ctx) {
    var r1 = harness.handle('thinking-tags/get', async () => ({ markers }))
    var r2 = harness.handle('thinking-tags/add', async (args) => {
      var tag = typeof args === 'object' && args !== null && typeof args.tag === 'string' ? args.tag.trim() : ''
      if (tag.length > 0 && !markers.includes(tag)) markers.push(tag)
      return { markers }
    })
    var r3 = harness.handle('thinking-tags/remove', async (args) => {
      var tag = typeof args === 'object' && args !== null && typeof args.tag === 'string' ? args.tag : ''
      var idx = markers.indexOf(tag)
      if (idx !== -1) markers.splice(idx, 1)
      return { markers }
    })
    ctx.effect(function () { return function () { r1(); r2(); r3() } })
  },
}
