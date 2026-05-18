import SwiftUI

struct ATCListView: View {
    let server: AppConfig.Server

    @State private var facilities: [ATCFacility] = []
    @State private var errorMessage: String?
    @State private var isLoading: Bool = false
    @State private var streamTask: Task<Void, Never>?

    var body: some View {
        List {
            if isLoading && facilities.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            }
            ForEach(grouped, id: \.0) { (kind, items) in
                Section(kind.label) {
                    ForEach(items) { facility in
                        ATCRow(facility: facility)
                    }
                }
            }
            if let err = errorMessage {
                Text(err).foregroundStyle(.red).font(.caption)
            }
        }
        .navigationTitle("Active ATC")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await refreshOnce() }
        .task { start() }
        .onDisappear { streamTask?.cancel() }
    }

    private var grouped: [(ATCFacility.Kind, [ATCFacility])] {
        let groups = Dictionary(grouping: facilities, by: { $0.facilityKind })
        return ATCFacility.Kind.allCases.compactMap { kind in
            guard let list = groups[kind], !list.isEmpty else { return nil }
            return (kind, list.sorted(by: { ($0.airportName ?? "") < ($1.airportName ?? "") }))
        }
    }

    private func start() {
        streamTask?.cancel()
        isLoading = true
        streamTask = Task {
            for await event in LiveFlightsService.shared.atcStream(for: server) {
                if Task.isCancelled { break }
                switch event {
                case .success(let list):
                    facilities = list
                    errorMessage = nil
                    isLoading = false
                case .failure(let err):
                    errorMessage = err.localizedDescription
                    isLoading = false
                }
            }
        }
    }

    private func refreshOnce() async {
        do {
            let sessionId = try await LiveFlightsService.shared.sessionId(for: server)
            facilities = try await APIClient.shared.fetchATC(sessionId: sessionId)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct ATCRow: View {
    let facility: ATCFacility

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(.tint)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(facility.airportName ?? "Unknown facility")
                    .font(.body.weight(.medium))
                if let user = facility.username {
                    Text(user).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text(facility.facilityKind.label)
                .font(.caption.bold())
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(.tint.opacity(0.15), in: Capsule())
        }
    }

    private var icon: String {
        switch facility.facilityKind {
        case .ground: return "car.fill"
        case .tower: return "antenna.radiowaves.left.and.right"
        case .approach, .departure: return "airplane.arrival"
        case .center: return "globe"
        case .atis: return "waveform"
        default: return "dot.radiowaves.left.and.right"
        }
    }
}
