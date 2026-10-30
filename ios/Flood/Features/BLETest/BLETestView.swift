import SwiftUI

/// Settings → Bluetooth test. Talks to `firmware/ble_hello` or `firmware/flood`; see `BLETester`.
struct BLETestView: View {
    @State private var tester = BLETester()
    @State private var draft = ""
    @State private var ssid = ""
    @State private var password = ""

    var body: some View {
        Form {
            Section("Status") {
                Label(tester.status,
                      systemImage: tester.ready ? "checkmark.circle.fill" : "antenna.radiowaves.left.and.right")
                    .foregroundStyle(tester.ready ? Color.green : Color.primary)
            }

            Section {
                Button("Send ping") { tester.send("ping") }
                HStack {
                    TextField("Anything else", text: $draft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Send") {
                        tester.send(draft)
                        draft = ""
                    }
                    .disabled(draft.isEmpty)
                }
            } footer: {
                Text("The sensor answers ping with pong and echoes anything else.")
            }
            .disabled(!tester.ready)

            if tester.canSendWiFi {
                Section {
                    TextField("WiFi name", text: $ssid)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("WiFi password", text: $password)
                    LabeledContent("Server", value: AppConfig.baseURL.absoluteString)
                        .font(.footnote)
                    Button("Send WiFi to sensor") {
                        tester.sendWiFi(ssid: ssid, password: password,
                                        serverURL: AppConfig.baseURL.absoluteString)
                    }
                    .disabled(ssid.isEmpty)
                } header: {
                    Text("WiFi")
                } footer: {
                    Text("Goes straight to the sensor over Bluetooth and is saved there. "
                         + "The sensor needs 2.4 GHz WiFi.")
                }
            }

            Section("Messages") {
                if tester.log.isEmpty {
                    Text("Nothing yet.").foregroundStyle(.secondary)
                }
                ForEach(tester.log.reversed()) { line in
                    switch line.kind {
                    case .sent:
                        Label(line.text, systemImage: "arrow.up.circle")
                    case .received:
                        Label(line.text, systemImage: "arrow.down.circle.fill")
                            .foregroundStyle(.green)
                    case .status:
                        Label(line.text, systemImage: "wifi")
                            .foregroundStyle(line.text.contains("failed") || line.text.contains("invalid")
                                             ? Color.red : Color.orange)
                    case .info:
                        Text(line.text).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .font(.system(.body, design: .monospaced))
        }
        .navigationTitle("Bluetooth test")
        .onAppear { tester.start() }
        .onDisappear { tester.stop() }
    }
}
