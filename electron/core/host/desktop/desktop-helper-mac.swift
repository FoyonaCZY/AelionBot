// The macOS half of host Computer Use: window discovery, capture, accessibility and input.
// scripts/build-desktop-helper.mjs compiles this one file with swiftc; desktop-helper.ts starts the binary and sends one
// JSON request per line, the same protocol the Windows helper speaks. Looking at a window, pressing a control, setting
// a value and choosing a menu command go through the window server and the accessibility tree and leave the window
// where it is; only real pointer and keyboard input brings it to the front.
import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation
import ImageIO

struct HelperError: Error {
  let code: String
  let message: String
}

// The window server's id for an accessibility window. Private, and what every window manager relies on.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ identifier: UnsafeMutablePointer<CGWindowID>) -> AXError

// ---------- accessibility ----------
func axValue(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}
func axString(_ element: AXUIElement, _ attribute: String) -> String? {
  return axValue(element, attribute) as? String
}
func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
  return (axValue(element, attribute) as? NSNumber)?.boolValue
}
func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
  guard let value = axValue(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}
func axElements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
  guard let value = axValue(element, attribute), let items = value as? [AnyObject] else { return [] }
  return items.filter { CFGetTypeID($0) == AXUIElementGetTypeID() }.map { $0 as! AXUIElement }
}
func axRect(_ position: AnyObject?, _ size: AnyObject?) -> CGRect? {
  guard let position = position, let size = size, CFGetTypeID(position) == AXValueGetTypeID(),
    CFGetTypeID(size) == AXValueGetTypeID()
  else { return nil }
  var origin = CGPoint.zero
  var extent = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &extent)
  else { return nil }
  return CGRect(origin: origin, size: extent)
}
func axFrame(_ element: AXUIElement) -> CGRect? {
  return axRect(axValue(element, "AXPosition"), axValue(element, "AXSize"))
}
/** Several attributes in one round trip; nil where the element has none. */
func axMany(_ element: AXUIElement, _ attributes: [String]) -> [AnyObject?] {
  var values: CFArray?
  let empty = [AnyObject?](repeating: nil, count: attributes.count)
  guard
    AXUIElementCopyMultipleAttributeValues(
      element, attributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
    let items = values as? [AnyObject], items.count == attributes.count
  else { return empty }
  return items.map { item -> AnyObject? in
    if item is NSNull { return nil }
    if CFGetTypeID(item) == AXValueGetTypeID(), AXValueGetType(item as! AXValue) == .axError { return nil }
    return item
  }
}
func axActions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
  return list
}
func axSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
  var settable: DarwinBoolean = false
  return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
}
func frontPid() -> pid_t? {
  guard let app = axElement(AXUIElementCreateSystemWide(), "AXFocusedApplication") else { return nil }
  var pid: pid_t = 0
  return AXUIElementGetPid(app, &pid) == .success ? pid : nil
}

// ---------- windows and the apps behind them ----------
struct ServerWindow {
  let id: CGWindowID
  let pid: pid_t
  let layer: Int
  let bounds: CGRect
  let alpha: Double
  let title: String
}
/** The window server's list, front to back. */
func serverWindows(_ options: CGWindowListOption, _ relative: CGWindowID = kCGNullWindowID) -> [ServerWindow] {
  guard let list = CGWindowListCopyWindowInfo(options, relative) as? [[String: Any]] else { return [] }
  return list.compactMap { info -> ServerWindow? in
    guard let number = info[kCGWindowNumber as String] as? NSNumber,
      let owner = info[kCGWindowOwnerPID as String] as? NSNumber,
      let box = info[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(dictionaryRepresentation: box as CFDictionary)
    else { return nil }
    return ServerWindow(
      id: number.uint32Value, pid: owner.int32Value,
      layer: (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0, bounds: bounds,
      alpha: (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
      title: (info[kCGWindowName as String] as? String) ?? "")
  }
}
struct AppWindow {
  let id: CGWindowID
  let element: AXUIElement
  let subrole: String
}
func appElement(_ pid: pid_t) -> AXUIElement {
  let app = AXUIElementCreateApplication(pid)
  // An app that hangs must not hang the helper with it.
  _ = AXUIElementSetMessagingTimeout(app, 2.0)
  return app
}
func appWindows(_ pid: pid_t) -> [AppWindow] {
  return axElements(appElement(pid), "AXWindows").compactMap { element -> AppWindow? in
    var id: CGWindowID = 0
    guard _AXUIElementGetWindow(element, &id) == .success, id != 0 else { return nil }
    return AppWindow(id: id, element: element, subrole: axString(element, "AXSubrole") ?? "")
  }
}
struct AppInfo {
  let path: String
  let name: String
  let regular: Bool
}
var appCache: [pid_t: AppInfo] = [:]
func appInfo(_ pid: pid_t) -> AppInfo {
  if let known = appCache[pid] { return known }
  let running = NSRunningApplication(processIdentifier: pid)
  let info = AppInfo(
    path: running?.bundleURL?.path ?? running?.executableURL?.path ?? "", name: running?.localizedName ?? "",
    regular: running?.activationPolicy == .regular)
  appCache[pid] = info
  return info
}
func describe(_ window: AppWindow, _ pid: pid_t, _ front: pid_t?, _ fallback: ServerWindow?) -> [String: Any] {
  let app = appInfo(pid)
  let frame = axFrame(window.element) ?? fallback?.bounds ?? CGRect.zero
  let title = axString(window.element, "AXTitle") ?? fallback?.title ?? ""
  return [
    "id": Int(window.id), "title": title, "className": window.subrole, "pid": Int(pid), "exe": app.path,
    "name": app.name, "minimized": axBool(window.element, "AXMinimized") ?? false,
    "foreground": front == pid && (axBool(window.element, "AXMain") ?? false), "elevated": false,
    // Nothing here can tell which apps keep drawing while covered, so every window is taken to stop.
    "pausesWhenCovered": true,
    "x": Int(frame.minX.rounded()), "y": Int(frame.minY.rounded()), "width": Int(frame.width.rounded()),
    "height": Int(frame.height.rounded()),
  ]
}
/** The windows a person would name: front to back, minimized ones last. */
func listWindows() -> [[String: Any]] {
  let all = serverWindows([.optionAll, .excludeDesktopElements])
  let onScreen = serverWindows([.optionOnScreenOnly, .excludeDesktopElements])
  var order: [CGWindowID: Int] = [:]
  for (index, window) in onScreen.enumerated() { order[window.id] = index }
  var byId: [CGWindowID: ServerWindow] = [:]
  var pids: [pid_t] = []
  for window in all where window.layer == 0 {
    byId[window.id] = window
    if !pids.contains(window.pid) { pids.append(window.pid) }
  }
  let front = frontPid()
  var found: [(Int, [String: Any])] = []
  for pid in pids where appInfo(pid).regular {
    for window in appWindows(pid) where window.subrole == "AXStandardWindow" || window.subrole == "AXDialog" {
      let info = describe(window, pid, front, byId[window.id])
      if (info["title"] as? String ?? "").isEmpty && window.subrole != "AXStandardWindow" { continue }
      found.append((order[window.id] ?? Int.max, info))
    }
  }
  return found.sorted { $0.0 < $1.0 }.map { $0.1 }
}
struct Target {
  let id: CGWindowID
  let pid: pid_t
  let element: AXUIElement?
  let server: ServerWindow
}
func target(_ request: [String: Any]) throws -> Target {
  guard let number = request["window"] as? NSNumber else { throw HelperError(code: "invalid", message: "window missing") }
  let id = number.uint32Value
  guard let server = serverWindows([.optionIncludingWindow], id).first(where: { $0.id == id }) else {
    throw HelperError(code: "window_gone", message: "window no longer exists")
  }
  return Target(
    id: id, pid: server.pid, element: appWindows(server.pid).first(where: { $0.id == id })?.element, server: server)
}
func describe(_ target: Target) -> [String: Any] {
  if let element = target.element {
    return describe(
      AppWindow(id: target.id, element: element, subrole: axString(element, "AXSubrole") ?? ""), target.pid, frontPid(),
      target.server)
  }
  let app = appInfo(target.pid)
  let frame = target.server.bounds
  return [
    "id": Int(target.id), "title": target.server.title, "className": "", "pid": Int(target.pid), "exe": app.path,
    "name": app.name, "minimized": false, "foreground": false, "elevated": false, "pausesWhenCovered": true,
    "x": Int(frame.minX.rounded()), "y": Int(frame.minY.rounded()), "width": Int(frame.width.rounded()),
    "height": Int(frame.height.rounded()),
  ]
}
func foreground() -> Any {
  guard let pid = frontPid() else { return NSNull() }
  let app = appElement(pid)
  guard let element = axElement(app, "AXFocusedWindow") ?? axElement(app, "AXMainWindow") else { return NSNull() }
  var id: CGWindowID = 0
  guard _AXUIElementGetWindow(element, &id) == .success, id != 0 else { return NSNull() }
  let server = serverWindows([.optionIncludingWindow], id).first(where: { $0.id == id })
  return describe(AppWindow(id: id, element: element, subrole: axString(element, "AXSubrole") ?? ""), pid, pid, server)
}

// ---------- installed apps ----------
func listApps() -> [[String: Any]] {
  let manager = FileManager.default
  let home = NSHomeDirectory()
  var seen = Set<String>()
  var apps: [[String: Any]] = []
  func add(_ path: String) {
    var name = manager.displayName(atPath: path)
    if name.hasSuffix(".app") { name = String(name.dropLast(4)) }
    if name.isEmpty || seen.contains(name.lowercased()) { return }
    seen.insert(name.lowercased())
    apps.append(["name": name, "id": path])
  }
  for folder in [
    "/Applications", home + "/Applications", "/System/Applications", "/Applications/Utilities",
    "/System/Applications/Utilities",
  ] {
    guard let entries = try? manager.contentsOfDirectory(atPath: folder) else { continue }
    for entry in entries.sorted() where !entry.hasPrefix(".") {
      let path = folder + "/" + entry
      if entry.hasSuffix(".app") {
        add(path)
        continue
      }
      // One level of folders, where suites keep their apps.
      var directory: ObjCBool = false
      guard manager.fileExists(atPath: path, isDirectory: &directory), directory.boolValue,
        let nested = try? manager.contentsOfDirectory(atPath: path)
      else { continue }
      for item in nested.sorted() where item.hasSuffix(".app") { add(path + "/" + item) }
    }
  }
  return apps
}
func launch(_ request: [String: Any]) throws {
  guard let id = request["id"] as? String, id.hasPrefix("/"), id.hasSuffix(".app") else {
    throw HelperError(code: "invalid", message: "invalid app id")
  }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  // -g: behind the app in use.
  process.arguments = ["-g", "-a", id]
  process.standardOutput = FileHandle.nullDevice
  process.standardError = FileHandle.nullDevice
  do { try process.run() } catch { throw HelperError(code: "failed", message: "could not start the app") }
  process.waitUntilExit()
  if process.terminationStatus != 0 { throw HelperError(code: "failed", message: "the system could not open the app") }
}

// ---------- foreground ----------
func activate(_ target: Target) -> Bool {
  if let element = target.element {
    if axBool(element, "AXMinimized") == true {
      _ = AXUIElementSetAttributeValue(element, "AXMinimized" as CFString, kCFBooleanFalse)
      usleep(350_000)
    }
    _ = AXUIElementPerformAction(element, "AXRaise" as CFString)
    _ = AXUIElementSetAttributeValue(element, "AXMain" as CFString, kCFBooleanTrue)
  }
  if frontPid() == target.pid { return true }
  _ = AXUIElementSetAttributeValue(appElement(target.pid), "AXFrontmost" as CFString, kCFBooleanTrue)
  for attempt in 0..<40 {
    if frontPid() == target.pid { return true }
    if attempt == 8 { _ = NSRunningApplication(processIdentifier: target.pid)?.activate(options: []) }
    usleep(25_000)
  }
  return frontPid() == target.pid
}
/// An action meant for the background that brought its app forward gives the front back to the app in use.
func handBack(_ pid: pid_t, _ before: pid_t?) {
  guard let before = before, before != pid else { return }
  for _ in 0..<8 {
    if frontPid() == pid {
      _ = AXUIElementSetAttributeValue(appElement(before), "AXFrontmost" as CFString, kCFBooleanTrue)
      return
    }
    usleep(15_000)
  }
}

// ---------- capture ----------
typealias WindowImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
// The SDK no longer declares this for Swift, and it is still how one window is read whole while others cover it.
let windowImage: WindowImage? = {
  guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
  return unsafeBitCast(symbol, to: WindowImage.self)
}()
func picture(_ id: CGWindowID) -> CGImage? {
  // 8: this window only. 1 | 16: without its shadow, one pixel per point.
  if let read = windowImage, let image = read(CGRect.null, 8, id, 1 | 16)?.takeRetainedValue() { return image }
  let file = NSTemporaryDirectory() + "aelion-window-\(getpid())-\(id).png"
  defer { try? FileManager.default.removeItem(atPath: file) }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  process.arguments = ["-x", "-o", "-l", String(id), "-t", "png", file]
  process.standardOutput = FileHandle.nullDevice
  process.standardError = FileHandle.nullDevice
  guard (try? process.run()) != nil else { return nil }
  process.waitUntilExit()
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(source, 0, nil)
}
/** The app's own windows as the screen shows them: the target plus what it has opened above itself. Front to back. */
func layers(_ target: Target) -> [ServerWindow] {
  let onScreen = serverWindows([.optionOnScreenOnly, .excludeDesktopElements])
  guard let index = onScreen.firstIndex(where: { $0.id == target.id }) else { return [target.server] }
  let near = onScreen[index].bounds.insetBy(dx: -400, dy: -400)
  // Another document window of the same app is a separate window to observe, not part of this one.
  let standard = Set(appWindows(target.pid).filter { $0.subrole == "AXStandardWindow" }.map { $0.id })
  var result: [ServerWindow] = []
  for window in onScreen[..<index]
  where window.pid == target.pid && window.alpha > 0 && window.layer <= 101 && !standard.contains(window.id)
    && window.bounds.width > 1 && window.bounds.height > 1 && window.bounds.intersects(near)
  {
    result.append(window)
  }
  result.append(onScreen[index])
  return result
}
var elementsByWindow: [CGWindowID: [AXUIElement]] = [:]
func capture(_ request: [String: Any]) throws -> [String: Any] {
  var window = try target(request)
  guard let file = request["file"] as? String else { throw HelperError(code: "invalid", message: "file missing") }
  let maxEdge = (request["maxEdge"] as? NSNumber)?.doubleValue ?? 1600
  let text = (request["text"] as? NSNumber)?.boolValue ?? false
  let front = (request["front"] as? NSNumber)?.boolValue ?? false
  if !CGPreflightScreenCaptureAccess() {
    throw HelperError(code: "screen_permission", message: "screen recording is not allowed")
  }
  if front {
    if !activate(window) {
      throw HelperError(code: "not_foreground", message: "the window could not be brought to the front")
    }
    usleep(120_000)
    window = try target(request)
  } else if let element = window.element, axBool(element, "AXMinimized") == true {
    throw HelperError(code: "blank", message: "a minimized window has no picture")
  }
  let parts = layers(window)
  var area = CGRect.null
  for part in parts { area = area.union(part.bounds) }
  if area.isNull || area.width < 2 || area.height < 2 {
    throw HelperError(code: "not_visible", message: "the window is not on screen")
  }
  let scale = min(1.0, maxEdge / Double(max(area.width, area.height)))
  let width = max(1, Int((Double(area.width) * scale).rounded()))
  let height = max(1, Int((Double(area.height) * scale).rounded()))
  guard
    let context = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
  else { throw HelperError(code: "failed", message: "could not create the image") }
  context.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context.interpolationQuality = .high
  var drawn = false
  for part in parts.reversed() {
    guard let image = picture(part.id) else { continue }
    // Screen coordinates grow downwards; the drawing context grows upwards.
    let box = CGRect(
      x: Double(part.bounds.minX - area.minX) * scale, y: Double(area.maxY - part.bounds.maxY) * scale,
      width: Double(part.bounds.width) * scale, height: Double(part.bounds.height) * scale)
    context.draw(image, in: box)
    if part.id == window.id { drawn = true }
  }
  var blank = true
  if drawn, let data = context.data {
    let bytes = data.bindMemory(to: UInt8.self, capacity: context.bytesPerRow * height)
    var row = 0
    while row < height && blank {
      var column = 0
      while column < width {
        let at = row * context.bytesPerRow + column * 4
        if bytes[at] > 12 || bytes[at + 1] > 12 || bytes[at + 2] > 12 {
          blank = false
          break
        }
        column += 3
      }
      row += 4
    }
  }
  if blank { throw HelperError(code: "blank", message: "the window gave no picture of itself") }
  guard let image = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(
      URL(fileURLWithPath: file) as CFURL, "public.png" as CFString, 1, nil)
  else { throw HelperError(code: "failed", message: "could not write the image") }
  CGImageDestinationAddImage(destination, image, nil)
  if !CGImageDestinationFinalize(destination) {
    throw HelperError(code: "failed", message: "could not write the image")
  }
  var result = describe(window)
  result["originX"] = Int(area.minX.rounded())
  result["originY"] = Int(area.minY.rounded())
  result["scale"] = scale
  result["imageWidth"] = width
  result["imageHeight"] = height
  if text {
    var lines = ""
    var rects: [[Int]] = []
    var elements: [AXUIElement] = []
    let started = Date()
    var cut = false
    var roots: [AXUIElement] = []
    if let element = window.element { roots.append(element) }
    let own = appWindows(window.pid)
    for part in parts where part.id != window.id {
      if let other = own.first(where: { $0.id == part.id }) { roots.append(other.element) }
    }
    for root in roots {
      if visit(root, 0, area, scale, &lines, &rects, &elements, started) { cut = true }
    }
    if let bar = axElement(appElement(window.pid), "AXMenuBar") {
      let titles = axElements(bar, "AXChildren").dropFirst().compactMap { axString($0, "AXTitle") }.filter {
        !$0.isEmpty
      }
      if !titles.isEmpty { lines += "menu bar (select_menu): " + titles.joined(separator: " | ") + "\n" }
    }
    if cut { lines += "(more elements were not listed)\n" }
    result["text"] = lines
    result["elements"] = rects
    elementsByWindow[window.id] = elements
  }
  return result
}

// ---------- the accessibility tree as text ----------
let roleNames: [String: String] = [
  "AXButton": "Button", "AXCheckBox": "CheckBox", "AXRadioButton": "RadioButton", "AXTextField": "Edit",
  "AXSecureTextField": "Edit", "AXSearchField": "Edit", "AXTextArea": "Document", "AXWebArea": "Document",
  "AXStaticText": "Text", "AXLink": "Hyperlink", "AXImage": "Image", "AXMenuItem": "MenuItem",
  "AXMenuBarItem": "MenuItem", "AXMenu": "Menu", "AXMenuButton": "ComboBox", "AXPopUpButton": "ComboBox",
  "AXComboBox": "ComboBox", "AXSlider": "Slider", "AXRow": "ListItem", "AXCell": "DataItem", "AXTabGroup": "Tab",
  "AXList": "List", "AXOutline": "Tree", "AXTable": "Table", "AXGroup": "Group", "AXWindow": "Window",
  "AXSheet": "Window", "AXToolbar": "ToolBar", "AXScrollArea": "Pane", "AXHeading": "Header",
  "AXDisclosureTriangle": "Button", "AXIncrementor": "Spinner",
]
let interactive: Set<String> = [
  "Button", "CheckBox", "RadioButton", "Edit", "Document", "Hyperlink", "MenuItem", "ComboBox", "Slider",
  "ListItem", "DataItem", "Spinner",
]
func short(_ value: String, _ limit: Int) -> String {
  let flat = value.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
    .replacingOccurrences(of: "\"", with: "'").trimmingCharacters(in: .whitespaces)
  return flat.count > limit ? String(flat.prefix(limit)) + "..." : flat
}
/// Adds this element and what is under it; true when the list had to stop early.
func visit(
  _ element: AXUIElement, _ depth: Int, _ area: CGRect, _ scale: Double, _ lines: inout String, _ rects: inout [[Int]],
  _ elements: inout [AXUIElement], _ started: Date
) -> Bool {
  if elements.count >= 400 || Date().timeIntervalSince(started) > 4.5 { return true }
  let values = axMany(
    element, ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXEnabled", "AXFocused", "AXPosition", "AXSize"])
  let role = (values[0] as? String) ?? ""
  let subrole = (values[1] as? String) ?? ""
  let frame = axRect(values[7], values[8])
  // What lies outside the picture cannot be pointed at; its children are outside too.
  if depth > 0, let frame = frame, frame.width >= 1, frame.height >= 1, !frame.intersects(area) { return false }
  var type = roleNames[role] ?? (role.hasPrefix("AX") ? String(role.dropFirst(2)) : role)
  if subrole == "AXTabButton" { type = "TabItem" }
  var name = short((values[2] as? String) ?? "", 80)
  if name.isEmpty { name = short((values[3] as? String) ?? "", 80) }
  var value = ""
  var checked = false
  if let string = values[4] as? String {
    value = role == "AXSecureTextField" ? "" : short(string, 80)
  } else if let number = values[4] as? NSNumber {
    if type == "CheckBox" || type == "RadioButton" || type == "TabItem" {
      checked = number.intValue != 0
    } else {
      value = number.stringValue
    }
  }
  if type == "Text" && name.isEmpty {
    name = value
    value = ""
  }
  if let frame = frame, frame.width >= 1, frame.height >= 1,
    !name.isEmpty || !value.isEmpty || interactive.contains(type)
  {
    let x = Int((Double(frame.minX - area.minX) * scale).rounded())
    let y = Int((Double(frame.minY - area.minY) * scale).rounded())
    let w = max(1, Int((Double(frame.width) * scale).rounded()))
    let h = max(1, Int((Double(frame.height) * scale).rounded()))
    lines += String(repeating: " ", count: min(depth, 12)) + "\(elements.count) \(type)"
    if !name.isEmpty { lines += " \"\(name)\"" }
    if !value.isEmpty && value != name { lines += " = \"\(value)\"" }
    if checked { lines += " (checked)" }
    if let enabled = values[5] as? NSNumber, !enabled.boolValue { lines += " (disabled)" }
    if let focused = values[6] as? NSNumber, focused.boolValue { lines += " (focused)" }
    lines += " [\(x),\(y) \(w)x\(h)]\n"
    rects.append([x, y, w, h])
    elements.append(element)
  }
  // Tables and lists can hold thousands of rows; only the ones in view matter.
  var children: [AXUIElement] = []
  if role == "AXTable" || role == "AXOutline" { children = axElements(element, "AXVisibleRows") }
  if children.isEmpty && (role == "AXList" || role == "AXBrowser") {
    children = axElements(element, "AXVisibleChildren")
  }
  if children.isEmpty { children = axElements(element, "AXChildren") }
  var cut = false
  for child in children {
    if visit(child, depth + 1, area, scale, &lines, &rects, &elements, started) { cut = true }
    if elements.count >= 400 || Date().timeIntervalSince(started) > 4.5 { return true }
  }
  return cut
}
func observed(_ request: [String: Any], _ window: Target) throws -> AXUIElement {
  guard let index = (request["element"] as? NSNumber)?.intValue, let list = elementsByWindow[window.id], index >= 0,
    index < list.count
  else { throw HelperError(code: "element_stale", message: "element is not part of the latest observation") }
  return list[index]
}

// ---------- actions through the accessibility tree: no pointer, and the window stays where it is ----------
func press(_ request: [String: Any]) throws {
  let window = try target(request)
  let item = try observed(request, window)
  let count = (request["count"] as? NSNumber)?.intValue ?? 1
  if axBool(item, "AXEnabled") == false {
    throw HelperError(code: "element_disabled", message: "the element is disabled")
  }
  let role = axString(item, "AXRole") ?? ""
  // A double click has no meaning of its own here, and anything that opens a menu needs the app in front to show it.
  if count != 1 || ["AXPopUpButton", "AXMenuButton", "AXComboBox", "AXMenuBarItem"].contains(role) {
    throw HelperError(code: "unsupported", message: "this element needs a real click")
  }
  let before = frontPid()
  _ = AXUIElementSetMessagingTimeout(item, 2.5)
  if role == "AXRow" || role == "AXCell" {
    guard axSettable(item, "AXSelected"),
      AXUIElementSetAttributeValue(item, "AXSelected" as CFString, kCFBooleanTrue) == .success
    else { throw HelperError(code: "unsupported", message: "this row cannot be selected directly") }
  } else {
    guard axActions(item).contains("AXPress") else {
      throw HelperError(code: "unsupported", message: "this element has no action of its own")
    }
    let result = AXUIElementPerformAction(item, "AXPress" as CFString)
    // A button that opens a dialog may not answer until the dialog closes; the press itself has happened by then.
    if result != .success && result != .cannotComplete {
      throw HelperError(code: "unsupported", message: "the element refused the press")
    }
  }
  handBack(window.pid, before)
}
func setValue(_ request: [String: Any]) throws {
  let window = try target(request)
  let item = try observed(request, window)
  guard let value = request["value"] as? String else { throw HelperError(code: "invalid", message: "value missing") }
  let before = frontPid()
  guard axSettable(item, "AXValue"),
    AXUIElementSetAttributeValue(item, "AXValue" as CFString, value as CFString) == .success
  else { throw HelperError(code: "unsupported", message: "this element does not accept a value") }
  handBack(window.pid, before)
}
/// Moves the scroll bar of the pane under the point, the way a wheel would.
func scroll(_ request: [String: Any]) throws {
  let window = try target(request)
  let dx = (request["dx"] as? NSNumber)?.doubleValue ?? 0
  let dy = (request["dy"] as? NSNumber)?.doubleValue ?? 0
  var current: AXUIElement?
  if request["element"] != nil {
    current = try observed(request, window)
  } else if let x = (request["x"] as? NSNumber)?.floatValue, let y = (request["y"] as? NSNumber)?.floatValue {
    var hit: AXUIElement?
    if AXUIElementCopyElementAtPosition(appElement(window.pid), x, y, &hit) == .success { current = hit }
  }
  var pane: AXUIElement?
  for _ in 0..<24 {
    guard let node = current else { break }
    if axString(node, "AXRole") == "AXScrollArea" {
      pane = node
      break
    }
    current = axElement(node, "AXParent")
  }
  guard let area = pane, let frame = axFrame(area) else {
    throw HelperError(code: "unsupported", message: "nothing here scrolls by itself")
  }
  let content = axElements(area, "AXContents").first.flatMap { axFrame($0) }
  var moved = false
  for (bar, delta, shown, whole) in [
    ("AXVerticalScrollBar", -dy, Double(frame.height), Double(content?.height ?? 0)),
    ("AXHorizontalScrollBar", dx, Double(frame.width), Double(content?.width ?? 0)),
  ] where delta != 0 {
    guard let scroller = axElement(area, bar), axSettable(scroller, "AXValue"),
      let position = (axValue(scroller, "AXValue") as? NSNumber)?.doubleValue
    else { continue }
    // A wheel notch moves about an eighth of what the pane shows.
    let hidden = max(1.0, whole - shown)
    let step = whole > shown ? 0.12 * shown / hidden : 0.1
    let next = min(1.0, max(0.0, position + delta * step))
    if AXUIElementSetAttributeValue(scroller, "AXValue" as CFString, NSNumber(value: next)) == .success {
      moved = true
    }
  }
  if !moved { throw HelperError(code: "unsupported", message: "nothing here scrolls by itself") }
}
func menuTitle(_ item: AXUIElement) -> String {
  return (axString(item, "AXTitle") ?? "").trimmingCharacters(in: .whitespaces)
}
func menuKey(_ title: String) -> String {
  var key = title.trimmingCharacters(in: .whitespaces).lowercased()
  for ending in ["…", "..."] where key.hasSuffix(ending) { key = String(key.dropLast(ending.count)) }
  return key.trimmingCharacters(in: .whitespaces)
}
/// Chooses a command from the app's menu bar by its path, without opening the menus.
func menu(_ request: [String: Any]) throws -> [String: Any] {
  let window = try target(request)
  guard let path = request["path"] as? [String], !path.isEmpty else {
    throw HelperError(code: "invalid", message: "path missing")
  }
  guard let bar = axElement(appElement(window.pid), "AXMenuBar") else {
    throw HelperError(code: "failed", message: "the app has no menu bar")
  }
  var items = axElements(bar, "AXChildren")
  var at: [String] = []
  for (index, wanted) in path.enumerated() {
    let titles = items.map { menuTitle($0) }.filter { !$0.isEmpty }
    guard let match = items.first(where: { menuKey(menuTitle($0)) == menuKey(wanted) }) else {
      return ["pressed": false, "at": at, "items": titles]
    }
    at.append(menuTitle(match))
    let under = axElements(match, "AXChildren").first(where: { axString($0, "AXRole") == "AXMenu" })
    let inside = under.map { axElements($0, "AXChildren") } ?? []
    if index == path.count - 1 {
      if !inside.isEmpty {
        return [
          "pressed": false, "submenu": true, "at": at,
          "items": inside.map { menuTitle($0) }.filter { !$0.isEmpty },
        ]
      }
      if axBool(match, "AXEnabled") == false {
        throw HelperError(code: "element_disabled", message: "the menu item is disabled")
      }
      let before = frontPid()
      _ = AXUIElementSetMessagingTimeout(match, 2.5)
      let result = AXUIElementPerformAction(match, "AXPress" as CFString)
      if result != .success && result != .cannotComplete {
        throw HelperError(code: "failed", message: "the menu item refused the press")
      }
      handBack(window.pid, before)
      return ["pressed": true, "at": at]
    }
    if inside.isEmpty { return ["pressed": false, "at": at, "items": [String]()] }
    items = inside
  }
  return ["pressed": false, "at": at, "items": [String]()]
}

// ---------- real input ----------
let eventSource = CGEventSource(stateID: .hidSystemState)
let ansiKeys: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
  "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
  "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
]
/// Letters and digits follow the keyboard layout in use, so CMD+Q is the key labelled Q on any keyboard.
func layoutKeys() -> [String: CGKeyCode] {
  var map: [String: CGKeyCode] = [:]
  guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
    let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
  else { return map }
  let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
  data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
    guard let layout = buffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
    for code in 0..<UInt16(51) {
      var dead: UInt32 = 0
      var length = 0
      var characters = [UniChar](repeating: 0, count: 4)
      let status = UCKeyTranslate(
        layout, code, UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask),
        &dead, characters.count, &length, &characters)
      if status != noErr || length != 1 { continue }
      let character = String(utf16CodeUnits: characters, count: 1).lowercased()
      if map[character] == nil { map[character] = code }
    }
  }
  return map
}
let fixedKeys: [Int: CGKeyCode] = [
  0x0D: 36, 0x1B: 53, 0x08: 51, 0x20: 49, 0x09: 48, 0x2E: 117, 0x2D: 114, 0x24: 115, 0x23: 119, 0x21: 116, 0x22: 121,
  0x26: 126, 0x28: 125, 0x25: 123, 0x27: 124, 0xBB: 24, 0xBD: 27, 0xBC: 43, 0xBE: 47, 0xBF: 44, 0x70: 122, 0x71: 120,
  0x72: 99, 0x73: 118, 0x74: 96, 0x75: 97, 0x76: 98, 0x77: 100, 0x78: 101, 0x79: 109, 0x7A: 103, 0x7B: 111,
]
let modifierKeys: [Int: (CGKeyCode, CGEventFlags)] = [
  0x11: (59, .maskControl), 0x12: (58, .maskAlternate), 0x10: (56, .maskShift), 0x5B: (55, .maskCommand),
]
/// The Mac key for a Windows virtual-key code, which is what requests carry on every system.
func keyCode(_ virtual: Int, _ layout: [String: CGKeyCode]) throws -> CGKeyCode {
  if let fixed = fixedKeys[virtual] { return fixed }
  if (0x30...0x39).contains(virtual) || (0x41...0x5A).contains(virtual), let scalar = Unicode.Scalar(virtual) {
    let character = String(Character(scalar)).lowercased()
    if let code = layout[character] ?? ansiKeys[character] { return code }
  }
  throw HelperError(code: "invalid", message: "unsupported key")
}
func postKey(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags) throws {
  guard let event = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: down) else {
    throw HelperError(code: "input_blocked", message: "the system rejected the input")
  }
  event.flags = flags
  event.post(tap: .cghidEventTap)
}
func chord(_ keys: [Int]) throws {
  let layout = layoutKeys()
  var flags: CGEventFlags = []
  var held: [(CGKeyCode, CGEventFlags)] = []
  var plain: [CGKeyCode] = []
  for key in keys {
    if let modifier = modifierKeys[key] { held.append(modifier) } else { plain.append(try keyCode(key, layout)) }
  }
  for (code, flag) in held {
    flags.insert(flag)
    try postKey(code, true, flags)
  }
  for code in plain { try postKey(code, true, flags) }
  usleep(20_000)
  for code in plain.reversed() { try postKey(code, false, flags) }
  for (code, flag) in held.reversed() {
    flags.remove(flag)
    try postKey(code, false, flags)
  }
}
func typeText(_ text: String, _ pid: pid_t) throws {
  var typed = 0
  for character in text {
    if character == "\r" { continue }
    if character == "\n" || character == "\r\n" || character == "\t" {
      let code: CGKeyCode = character == "\t" ? 48 : 36
      try postKey(code, true, [])
      try postKey(code, false, [])
    } else {
      let units = Array(String(character).utf16)
      for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down) else {
          throw HelperError(code: "input_blocked", message: "the system rejected the input")
        }
        event.flags = []
        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        event.post(tap: .cghidEventTap)
      }
    }
    typed += 1
    if typed % 16 == 0 {
      usleep(8_000)
      if frontPid() != pid { throw HelperError(code: "not_foreground", message: "the app is no longer in front") }
    }
  }
}
/// Whether a click at this point lands on the app: the frontmost window there is one of its own.
func reaches(_ point: CGPoint, _ pid: pid_t) -> Bool {
  for window in serverWindows([.optionOnScreenOnly, .excludeDesktopElements]) {
    // Above the menus are overlays that take no clicks, such as the cue this app draws.
    if window.layer > 101 || window.layer < 0 || window.alpha <= 0 || !window.bounds.contains(point) { continue }
    return window.pid == pid
  }
  return false
}
func input(_ request: [String: Any]) throws {
  let window = try target(request)
  guard let steps = request["steps"] as? [[String: Any]] else {
    throw HelperError(code: "invalid", message: "steps missing")
  }
  if !activate(window) {
    throw HelperError(code: "not_foreground", message: "the window could not be brought to the front")
  }
  var cursor = CGEvent(source: nil)?.location ?? CGPoint.zero
  var pressed: [Int] = []
  let buttons: [(CGMouseButton, CGEventType, CGEventType, CGEventType)] = [
    (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged),
    (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged),
    (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged),
  ]
  func mouse(_ type: CGEventType, _ button: CGMouseButton, _ clicks: Int) throws {
    guard
      let event = CGEvent(
        mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: cursor, mouseButton: button)
    else { throw HelperError(code: "input_blocked", message: "the system rejected the input") }
    event.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
    event.post(tap: .cghidEventTap)
  }
  var done = 0
  defer {
    for button in pressed where button >= 0 && button < buttons.count {
      try? mouse(buttons[button].2, buttons[button].0, 1)
    }
  }
  do {
    for step in steps {
      let kind = step["t"] as? String ?? ""
      let number = { (key: String) -> Double in (step[key] as? NSNumber)?.doubleValue ?? 0 }
      if kind == "move" || kind == "check" {
        let point = CGPoint(x: number("x"), y: number("y"))
        if step["free"] == nil && !reaches(point, window.pid) {
          throw HelperError(code: "obscured", message: "another window covers that point")
        }
        if kind == "move" {
          cursor = point
          if let held = pressed.last, held >= 0, held < buttons.count {
            try mouse(buttons[held].3, buttons[held].0, 1)
          } else {
            try mouse(.mouseMoved, .left, 0)
          }
          usleep(15_000)
        }
      } else if kind == "down" || kind == "up" {
        let button = Int(number("button"))
        guard button >= 0, button < buttons.count else {
          throw HelperError(code: "invalid", message: "unknown mouse button")
        }
        let clicks = max(1, Int(number("n")))
        if kind == "down" {
          try mouse(buttons[button].1, buttons[button].0, clicks)
          pressed.append(button)
        } else {
          try mouse(buttons[button].2, buttons[button].0, clicks)
          pressed.removeAll { $0 == button }
        }
      } else if kind == "wheel" {
        // Requests count notches; a notch is three lines. Positive is up, and for the second wheel left.
        guard
          let event = CGEvent(
            scrollWheelEvent2Source: eventSource, units: .line, wheelCount: 2, wheel1: Int32(number("dy") * 3),
            wheel2: Int32(-number("dx") * 3), wheel3: 0)
        else { throw HelperError(code: "input_blocked", message: "the system rejected the input") }
        event.post(tap: .cghidEventTap)
      } else if kind == "key" || kind == "text" {
        if frontPid() != window.pid {
          throw HelperError(code: "not_foreground", message: "the app is no longer in front")
        }
        if kind == "key" {
          try chord((step["keys"] as? [NSNumber] ?? []).map { $0.intValue })
        } else {
          try typeText(step["text"] as? String ?? "", window.pid)
        }
      } else if kind == "sleep" {
        usleep(UInt32(min(2000, max(0, number("ms"))) * 1000))
      } else {
        throw HelperError(code: "invalid", message: "unknown input step")
      }
      done += 1
    }
  } catch let error as HelperError {
    throw HelperError(code: error.code, message: error.message + " (step \(done))")
  }
}

// ---------- protocol: one JSON object per line, ASCII only ----------
func display() -> [Int] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  var whole = CGRect.null
  for id in ids.prefix(Int(count)) { whole = whole.union(CGDisplayBounds(id)) }
  if whole.isNull { return [0, 0, 0, 0] }
  return [Int(whole.minX), Int(whole.minY), Int(whole.width), Int(whole.height)]
}
func perform(_ op: String, _ request: [String: Any]) throws -> Any {
  if op == "ping" {
    return [
      "pid": Int(getpid()), "elevated": false, "accessibility": AXIsProcessTrusted(),
      "screenRecording": CGPreflightScreenCaptureAccess(), "display": display(),
    ] as [String: Any]
  }
  if op == "request_permission" {
    if request["kind"] as? String == "screen" {
      _ = CGRequestScreenCaptureAccess()
    } else {
      _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }
    return [String: Any]()
  }
  if op == "list_apps" { return listApps() }
  if op == "launch" {
    try launch(request)
    return [String: Any]()
  }
  // Everything else reads or operates other apps.
  if !AXIsProcessTrusted() {
    throw HelperError(code: "accessibility_permission", message: "accessibility is not allowed")
  }
  if op == "list_windows" { return listWindows() }
  if op == "window" {
    let window = try target(request)
    return describe(window)
  }
  if op == "foreground" { return foreground() }
  if op == "activate" {
    let window = try target(request)
    return ["foreground": activate(window)]
  }
  if op == "capture" { return try capture(request) }
  if op == "menu" { return try menu(request) }
  if op == "press" { try press(request) } else if op == "scroll" { try scroll(request) } else if op == "set_value" {
    try setValue(request)
  } else if op == "input" {
    try input(request)
  } else {
    throw HelperError(code: "invalid", message: "unknown operation")
  }
  return [String: Any]()
}
func answer(_ reply: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: reply, options: []),
    let text = String(data: data, encoding: .utf8)
  else { return }
  var line = [UInt8]()
  line.reserveCapacity(text.utf8.count + 16)
  for unit in text.utf16 {
    if unit < 0x20 || unit > 0x7E {
      line.append(contentsOf: Array(String(format: "\\u%04x", Int(unit)).utf8))
    } else {
      line.append(UInt8(unit))
    }
  }
  line.append(0x0A)
  FileHandle.standardOutput.write(Data(line))
}

answer(["ready": true])
while let line = readLine(strippingNewline: true) {
  if line.isEmpty { continue }
  var reply: [String: Any] = [:]
  // Apps come and go between requests.
  appCache.removeAll()
  if let data = line.data(using: .utf8),
    let request = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any]
  {
    reply["id"] = request["id"] ?? NSNull()
    do {
      let result: Any = try autoreleasepool { () throws -> Any in
        try perform(request["op"] as? String ?? "", request)
      }
      reply["result"] = result
      reply["ok"] = true
    } catch let error as HelperError {
      reply["ok"] = false
      reply["code"] = error.code
      reply["error"] = error.message
    } catch {
      reply["ok"] = false
      reply["code"] = "failed"
      reply["error"] = error.localizedDescription
    }
  } else {
    reply["ok"] = false
    reply["code"] = "invalid"
    reply["error"] = "request is not JSON"
  }
  answer(reply)
}
