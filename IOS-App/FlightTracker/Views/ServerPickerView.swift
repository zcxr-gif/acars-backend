import SwiftUI

struct ServerPickerView: View {
    let selection: AppConfig.Server
    let onSelect: (AppConfig.Server) -> Void

    var body: some View {
        NavigationStack {
            List(AppConfig.Server.allCases) { server in
                Button {
                    onSelect(server)
                } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(server.shortName).font(.headline)
                            Text(server.rawValue)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if server == selection {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.tint)
                        }
                    }
                }
                .tint(.primary)
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
