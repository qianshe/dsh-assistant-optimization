// dsh-assistant-optimization — Host 半体（单一真源）
//
// 最终方案：不做数据源拦截。只维护"用户配置的 thinking 分割标记"列表，
// 通过纯 JSON RPC 暴露给 Client。分割/折叠/渲染全部在客户端渲染层完成。
//
// 加载方式：把本文件内容作为 cordis_define 的 code.host 传入。
// 依赖（均已通过 Inspect 核实）：
//   - Host Builtin harness.handle(method, handler)  纯 JSON RPC
//
// 注意：函数体按纯 JS 函数求值，`return` 之后的语句永不执行，
//       所有 const/函数声明必须放在 return 之前。

// 默认标记：模型输出里"正文前推理内容"与"正文"之间的分割字符串。
// 覆盖常见闭合标签形态；用户可在设置页增删（含 <> 完整字符串）。
const DEFAULT_MARKERS = ['</think>']

// 进程内可变标记列表（add/remove 是仅有的变更入口）。
const markers = [...DEFAULT_MARKERS]

return {
  apply(ctx) {
    // —— RPC：读取当前标记列表 ——
    harness.handle('thinking-tags/get', async () => ({ markers }))

    // —— RPC：新增一个标记（trim 后非空、不重复才加入）——
    harness.handle('thinking-tags/add', async (args) => {
      const tag = typeof args?.tag === 'string' ? args.tag.trim() : ''
      if (tag.length > 0 && !markers.includes(tag)) markers.push(tag)
      return { markers }
    })

    // —— RPC：移除一个标记 ——
    harness.handle('thinking-tags/remove', async (args) => {
      const tag = typeof args?.tag === 'string' ? args.tag : ''
      const idx = markers.indexOf(tag)
      if (idx !== -1) markers.splice(idx, 1)
      return { markers }
    })
  },
}