import SwiftUI

struct NotamsView: View {
    let server: AppConfig.Server

    @State private var notams: [NotamItem] = []
    @State private var errorMessage: String?
    @State private var isLoading: Bool = false

    var body: some View {
        List {
            if isLoading {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let err = errorMessage {
                Text(err).foregroundStyle(.red).font(.caption)
            }
            ForEach(notams) { notam in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        if let icao = notam.icao {
                            Text(icao).font(.caption.monospaced().bold())
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(.tint.opacity(0.2), in: Capsule())
                        }
                        if let title = notam.title {
                            Text(title).font(.headline)
                        }
                        Spacer()
                    }
                    if let message = notam.message {
                        Text(message).font(.callout)
                    }
                    HStack {
                        if let author = notam.author {
                            Label(author, systemImage: "person").font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let end = notam.endTime {
                            Label(end, systemImage: "clock").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            if notams.isEmpty && !isLoading {
                Text("No active NOTAMs").foregroundStyle(.secondary)
            }
        }
        .navigationTitle("NOTAMs")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let sessionId = try await LiveFlightsService.shared.sessionId(for: server)
            notams = try await APIClient.shared.fetchNotams(sessionId: sessionId)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
