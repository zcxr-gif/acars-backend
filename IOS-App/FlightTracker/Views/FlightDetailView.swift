import SwiftUI
import MapKit

struct FlightDetailView: View {
    let flight: Flight
    let server: AppConfig.Server

    @StateObject private var vm = FlightDetailViewModel()
    @State private var sessionId: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                miniMap
                telemetry
                routeSection
                pilotSection
            }
            .padding()
        }
        .navigationTitle(flight.callsign.isEmpty ? "Flight" : flight.callsign)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                let id = try await LiveFlightsService.shared.sessionId(for: server)
                sessionId = id
                await vm.load(flight: flight, sessionId: id)
            } catch {
                vm.errorMessage = error.localizedDescription
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(flight.callsign).font(.title.bold())
                if flight.isStaff == true {
                    Label("Staff", systemImage: "star.fill")
                        .font(.caption)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(.yellow.opacity(0.2), in: Capsule())
                } else if flight.isVAMember == true {
                    Label(flight.virtualOrganization ?? "VA", systemImage: "building.2")
                        .font(.caption)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(.blue.opacity(0.2), in: Capsule())
                }
            }
            Text(flight.username ?? "Unknown pilot")
                .foregroundStyle(.secondary)
            if let dep = flight.departureIcao, let arr = flight.arrivalIcao {
                HStack(spacing: 8) {
                    Text(dep).font(.title3.monospaced().bold())
                    Image(systemName: "arrow.right")
                        .foregroundStyle(.secondary)
                    Text(arr).font(.title3.monospaced().bold())
                }
            }
        }
    }

    private var miniMap: some View {
        let camera: MapCameraPosition = {
            if let coord = flight.coordinate {
                return .region(MKCoordinateRegion(
                    center: coord,
                    span: MKCoordinateSpan(latitudeDelta: 4, longitudeDelta: 4)
                ))
            }
            return .automatic
        }()

        return Map(initialPosition: camera) {
            if !vm.historyCoordinates.isEmpty {
                MapPolyline(coordinates: vm.historyCoordinates)
                    .stroke(.tint, lineWidth: 3)
            }
            if !vm.planCoordinates.isEmpty {
                MapPolyline(coordinates: vm.planCoordinates)
                    .stroke(.secondary, style: StrokeStyle(lineWidth: 2, dash: [4, 4]))
            }
            if let coord = flight.coordinate {
                Annotation(flight.callsign, coordinate: coord) {
                    PlaneAnnotation(
                        heading: flight.position.heading_deg ?? 0,
                        isSelected: true
                    )
                }
            }
        }
        .frame(height: 240)
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var telemetry: some View {
        let p = flight.position
        return Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 12) {
            GridRow {
                MetricCard(label: "Altitude", value: format(p.alt_ft, suffix: "ft"))
                MetricCard(label: "Ground Speed", value: format(p.gs_kt, suffix: "kt"))
            }
            GridRow {
                MetricCard(label: "Heading", value: format(p.heading_deg, suffix: "°"))
                MetricCard(label: "Vert. Speed", value: format(p.vs_fpm, suffix: "fpm"))
            }
        }
    }

    @ViewBuilder
    private var routeSection: some View {
        if let waypoints = vm.plan?.waypoints, !waypoints.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Flight Plan").font(.headline)
                ForEach(waypoints) { wp in
                    HStack {
                        Image(systemName: "mappin.circle")
                            .foregroundStyle(.secondary)
                        Text(wp.name ?? "—").font(.body.monospaced())
                        Spacer()
                        if let alt = wp.altitude, alt > 0 {
                            Text("\(Int(alt)) ft").foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .padding()
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    @ViewBuilder
    private var pilotSection: some View {
        if let aircraft = flight.aircraft {
            VStack(alignment: .leading, spacing: 6) {
                Text("Aircraft").font(.headline)
                LabeledContent("Type", value: aircraft.aircraftName ?? "Unknown")
                LabeledContent("Livery", value: aircraft.liveryName ?? "Unknown")
            }
            .padding()
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func format(_ value: Double?, suffix: String) -> String {
        guard let v = value else { return "—" }
        return "\(Int(v.rounded())) \(suffix)"
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
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}
