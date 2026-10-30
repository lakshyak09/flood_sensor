import SwiftUI

struct DeviceEditView: View {
    let detail: DeviceDetail
    let onSaved: () async -> Void
    let onDeleted: () -> Void

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var location: String
    @State private var material: SurfaceMaterial
    @State private var error: String?
    @State private var busy = false
    @State private var confirmingDelete = false

    init(detail: DeviceDetail, onSaved: @escaping () async -> Void, onDeleted: @escaping () -> Void) {
        self.detail = detail
        self.onSaved = onSaved
        self.onDeleted = onDeleted
        _name = State(initialValue: detail.name)
        _location = State(initialValue: detail.location ?? "")
        _material = State(initialValue: detail.surfaceMaterial)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Name", text: $name)
                    TextField("Location", text: $location)
                }

                Section {
                    Picker("Surface", selection: $material) {
                        ForEach(SurfaceMaterial.allCases) { m in
                            Text(m.label).tag(m)
                        }
                    }
                } header: {
                    Text("Surface")
                } footer: {
                    if material != detail.surfaceMaterial {
                        // Worth saying plainly: the server deletes stored scores
                        // on a material change, because they describe a
                        // different surface.
                        Text("Changing the surface rescores this sensor and discards its "
                             + "previous risk history, which was calculated for "
                             + "\(detail.surfaceMaterial.label.lowercased()).")
                    } else {
                        Text("\(material.label) is treated as favorable for growth above "
                             + "\(material.thresholdPct)% humidity.")
                    }
                }

                Section {
                    Button("Remove sensor", role: .destructive) { confirmingDelete = true }
                } footer: {
                    Text("Removing a sensor deletes all of its readings, risk history and alerts. "
                         + "The sensor itself keeps working and can be added again by anyone.")
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Edit sensor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save).disabled(busy || name.isEmpty)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .alert("Remove this sensor?", isPresented: $confirmingDelete) {
                Button("Remove", role: .destructive, action: delete)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("All readings, risk history and alerts for \(detail.name) will be deleted. "
                     + "This cannot be undone.")
            }
        }
    }

    private func save() {
        busy = true
        error = nil
        Task {
            do {
                let trimmed = location.trimmingCharacters(in: .whitespaces)
                let _: DeviceDetail = try await session.api.authorized(
                    .updateDevice(detail.id,
                                  name: name.trimmingCharacters(in: .whitespaces),
                                  location: trimmed.isEmpty ? nil : trimmed,
                                  material: material)
                )
                await onSaved()
                dismiss()
            } catch {
                self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
            busy = false
        }
    }

    private func delete() {
        busy = true
        Task {
            do {
                try await session.api.authorizedVoid(.deleteDevice(detail.id))
                dismiss()
                onDeleted()
            } catch {
                self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
            busy = false
        }
    }
}
