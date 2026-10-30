import SwiftUI

struct AuthView: View {
    @Environment(SessionStore.self) private var session

    @State private var mode: Mode = .signIn
    @State private var email = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var error: String?
    @State private var busy = false
    @State private var showingServerSettings = false
    @FocusState private var focused: Field?

    enum Mode { case signIn, register }
    enum Field { case email, password, displayName }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    header

                    VStack(spacing: 12) {
                        TextField("Email", text: $email)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focused, equals: .email)
                            .submitLabel(.next)
                            .onSubmit { focused = .password }

                        SecureField("Password", text: $password)
                            .textContentType(mode == .register ? .newPassword : .password)
                            .focused($focused, equals: .password)
                            .submitLabel(mode == .register ? .next : .go)
                            .onSubmit {
                                if mode == .register { focused = .displayName } else { submit() }
                            }

                        if mode == .register {
                            TextField("Display name (optional)", text: $displayName)
                                .textContentType(.name)
                                .focused($focused, equals: .displayName)
                                .submitLabel(.go)
                                .onSubmit { submit() }
                        }
                    }
                    .textFieldStyle(.roundedBorder)

                    if mode == .register {
                        Text("Passwords must be at least 10 characters.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if let notice = session.expiryNotice, error == nil {
                        Label(notice, systemImage: "clock.badge.exclamationmark")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button(action: submit) {
                        if busy {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text(mode == .signIn ? "Sign in" : "Create account")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(busy || !isValid)

                    Button(mode == .signIn
                           ? "No account? Create one"
                           : "Already have an account? Sign in") {
                        withAnimation { mode = mode == .signIn ? .register : .signIn }
                        error = nil
                    }
                    .font(.footnote)
                }
                .padding(24)
            }
            // Land on the field the person is going to type in anyway.
            .onAppear { if email.isEmpty { focused = .email } }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Server", systemImage: "server.rack") {
                        showingServerSettings = true
                    }
                    .labelStyle(.iconOnly)
                }
            }
            .sheet(isPresented: $showingServerSettings) {
                ServerSettingsView()
            }
        }
    }

    private var header: some View {
        VStack(spacing: 8) {
            Image(systemName: "humidity.fill")
                .font(.system(size: 44))
                .foregroundStyle(.teal)
            Text("Flood")
                .font(.largeTitle.bold())
            Text("Catch damp before it becomes mold.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 32)
    }

    private var isValid: Bool {
        email.contains("@") && password.count >= (mode == .register ? 10 : 1)
    }

    private func submit() {
        busy = true
        error = nil
        Task {
            do {
                if mode == .signIn {
                    try await session.signIn(email: email, password: password)
                } else {
                    let name = displayName.trimmingCharacters(in: .whitespaces)
                    try await session.register(email: email, password: password,
                                               displayName: name.isEmpty ? nil : name)
                }
            } catch {
                self.error = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
            busy = false
        }
    }
}

/// Lets the server address be changed without a rebuild -- needed the moment
/// this runs anywhere other than the simulator.
struct ServerSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var address = UserDefaults.standard.string(forKey: AppConfig.baseURLDefaultsKey) ?? ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://127.0.0.1:3000/api/v1", text: $address)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } header: {
                    Text("Server address")
                } footer: {
                    Text("Leave blank to use the default, \(AppConfig.baseURL.absoluteString). "
                         + "Changing this takes effect next time the app launches.")
                }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        AppConfig.setBaseURL(address.trimmingCharacters(in: .whitespaces))
                        dismiss()
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
