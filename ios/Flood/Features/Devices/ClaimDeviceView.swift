import SwiftUI
import UIKit

/// Claiming a sensor by pasting its id and key.
///
/// The normal path is Bluetooth (`SensorSetupView`), which reads both off the
/// sensor itself. This is the fallback it offers as "Set up without Bluetooth":
/// for the simulator, which has no Bluetooth, and for the demo sensors, which
/// have no hardware. The values are what `scripts/provision-device.js` prints
/// and what the live feed's `n` command puts on the clipboard.
struct ClaimDeviceView: View {
    let onClaimed: () async -> Void

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss

    @State private var deviceId = ""
    @State private var deviceKey = ""
    @State private var name = ""
    @State private var location = ""
    @State private var material: SurfaceMaterial = .unknown
    @State private var error: String?
    @State private var busy = false
    @State private var pasteNote: String?
    @State private var pasteFailed = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Device ID", text: $deviceId)
                    TextField("Device key", text: $deviceKey)

                    Button {
                        paste()
                    } label: {
                        Label("Paste setup details", systemImage: "doc.on.clipboard")
                    }
                    .font(.body)
                } header: {
                    Text("From the sensor")
                } footer: {
                    Text(pasteNote ?? "Press `n` in the live feed, or run `npm run provision`, "
                         + "then paste both values here at once. This only adds the sensor to "
                         + "your account. It doesn't connect it to WiFi.")
                        .foregroundStyle(pasteFailed ? Color.red : Color.secondary)
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.system(.body, design: .monospaced))

                Section("Name it") {
                    TextField("Basement north wall", text: $name)
                    TextField("Location (optional)", text: $location)
                }

                Section {
                    Picker("Surface", selection: $material) {
                        ForEach(SurfaceMaterial.allCases) { m in
                            Text(m.label).tag(m)
                        }
                    }
                } header: {
                    Text("What is it pointed at?")
                } footer: {
                    Text("This changes the risk model. \(material.label) is treated as favorable "
                         + "for growth above \(material.thresholdPct)% humidity.")
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Add sensor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add", action: claim)
                        .disabled(busy || deviceId.isEmpty || deviceKey.isEmpty || name.isEmpty)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    /// Fill both fields from whatever is on the clipboard.
    ///
    /// Deliberately forgiving about the shape. The id and key reach a tester as
    /// JSON from the provisioning script, as two lines from the live feed, or
    /// as whatever survived a copy out of a terminal -- and none of that is
    /// worth a parse error when the two values are unmistakable on sight: one
    /// is a UUID, the other starts with `dk_`.
    private func paste() {
        guard let text = UIPasteboard.general.string, !text.isEmpty else {
            pasteNote = "The clipboard is empty."
            pasteFailed = true
            return
        }

        // Anything that is not part of an id or a key is a separator, which
        // makes quotes, braces, colons and newlines all fall away and leaves
        // JSON and two bare lines looking identical.
        let tokens = text
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "-" && $0 != "_" })
            .map(String.init)

        let foundKey = tokens.first { $0.hasPrefix("dk_") }
        let foundId = tokens.first { $0.count == 36 && $0.filter { $0 == "-" }.count == 4 }

        guard foundId != nil || foundKey != nil else {
            pasteNote = "Couldn't find a device id or key in what was copied."
            pasteFailed = true
            return
        }

        if let foundId { deviceId = foundId }
        if let foundKey { deviceKey = foundKey }
        pasteFailed = false
        pasteNote = foundId != nil && foundKey != nil
            ? "Pasted both values."
            : "Pasted what was there. The other one is still missing."
        Haptics.light()
    }

    private func claim() {
        busy = true
        error = nil
        Task {
            do {
                let trimmedLocation = location.trimmingCharacters(in: .whitespaces)
                let _: DeviceDetail = try await session.api.authorized(
                    .claimDevice(id: deviceId.trimmingCharacters(in: .whitespaces),
                                 key: deviceKey.trimmingCharacters(in: .whitespaces),
                                 name: name.trimmingCharacters(in: .whitespaces),
                                 location: trimmedLocation.isEmpty ? nil : trimmedLocation,
                                 material: material)
                )
                Haptics.success()
                await onClaimed()
                dismiss()
            } catch {
                self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
                Haptics.failure()
            }
            busy = false
        }
    }
}
