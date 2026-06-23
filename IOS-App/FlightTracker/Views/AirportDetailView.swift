import SwiftUI
import MapKit

struct AirportDetailView: View {
    let icao: String
    let server: AppConfig.Server

    @StateObject private var vm = AirportDetailViewModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if let coord = vm.airport?.coordinate {
                    Map(initialPosition: .region(MKCoordinateRegion(
                        center: coord,
                        span: MKCoordinateSpan(latitudeDelta: 0.5, longitudeDelta: 0.5)
                    ))) {
                        Marker(vm.airport?.name ?? icao, coordinate: coord)
                    }
                    .frame(height: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                }
                if let atis = vm.atis, !atis.isEmpty {
                    section("ATIS") {
                        Text(atis).font(.callout.monospaced())
                    }
                }
                if let status = vm.status {
                    statusSection(status)
                }
            }
            .padding()
        }
        .navigationTitle(icao.uppercased())
        .navigationBarTitleDisplayMode(.inline)
        .task {
            let sessionId = try? await LiveFlightsService.shared.sessionId(for: server)
            await vm.load(icao: icao, sessionId: sessionId)
        }
    }

    @ViewBuilder
    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(vm.airport?.name ?? icao.uppercased()).font(.title2.bold())
            if let city = vm.airport?.city {
                Text("\(city), \(vm.airport?.country ?? "")").foregroundStyle(.secondary)
            }
            HStack(spacing: 16) {
                if let iata = vm.airport?.iata { Tag(text: iata) }
                Tag(text: icao.uppercased())
                if let elev = vm.airport?.elevation {
                    Tag(text: "\(Int(elev)) ft elev")
                }
            }
        }
    }

    private func statusSection(_ status: AirportStatus) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Traffic").font(.headline)
            HStack {
                MetricCard(label: "Inbound", value: "\(status.inboundFlightsCount ?? 0)")
                MetricCard(label: "Outbound", value: "\(status.outboundFlightsCount ?? 0)")
            }
            if let atc = status.atcFacilities, !atc.isEmpty {
                Text("Active ATC").font(.headline).padding(.top, 8)
                ForEach(atc) { f in
                    ATCRow(facility: f)
                }
            }
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            content()
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct Tag: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.caption.bold())
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(.tint.opacity(0.15), in: Capsule())
    }
}

private struct MetricCard: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
