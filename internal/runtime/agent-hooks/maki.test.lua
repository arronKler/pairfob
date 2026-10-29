-- Test harness: the embedded managed plugin is inserted at the marker below.
local callbacks, calls = {}, {}
local focused = "main-session-one"
maki = {
  uv = { os_getenv = function(name)
    return ({ HERDR_ENV = "1", HERDR_PANE_ID = "w1:p1", HERDR_SOCKET_PATH = "/private/herdr.sock" })[name]
  end },
  fn = { jobstart = function(argv, options)
    assert(options.scope == "plugin")
    assert(options.stdout == false and options.stderr == false)
    table.insert(calls, argv)
    return #calls
  end },
  session = { current = function() return focused end },
  api = { create_autocmd = function(names, opts)
    if type(names) == "string" then names = { names } end
    for _, name in ipairs(names) do callbacks[name] = opts.callback end
  end },
}

-- INSERT_MANAGED_MAKI_PLUGIN

callbacks.SessionFocusChanged({ data = { session_id = focused } })
callbacks.TurnStart({ data = { session_id = "background-child" } })
callbacks.SessionEnd({ data = { session_id = "background-child" } })
focused = "main-session-two"
callbacks.SessionFocusChanged({ data = { session_id = focused } })
callbacks.TurnStart({ data = { session_id = focused } })
callbacks.SessionReset({ data = { session_id = focused } })
assert(#calls == 4)
for i, args in ipairs(calls) do
  assert(args[1] == "/safe/pairfob" and args[2] == "agent-hook" and args[3] == "maki")
  assert(args[4] == (i == 1 and "main-session-one" or "main-session-two"))
  assert(args[6] == (i == 4 and "clear" or "bind"))
  if i > 1 then assert(tonumber(args[5]) > tonumber(calls[i-1][5])) end
end
print("Maki focus, child filtering, reset and event ordering passed")
