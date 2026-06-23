import SwiftUI
import MapKit

struct FlightDetailView: View {
    let flight: Flight
    let server: AppConfig.Server

    @StateObject private var vm = FlightDetailViewModel()
    @State private var sessionId: String?
    @State private var liveries: [Livery] = []
    @State private var showLiveries: Bool = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                miniMap
                telemetry
                pilotStateRow
                routeSection
                pilotSection
                aircraftSection
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
            if let acId = flight.aircraft?.aircraftId {
                liveries = (try? await APIClient.shared.fetchLiveries(aircraftId: acId)) ?? []
            }
        }
    }

    @ViewBuilder
    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(flight.callsign).font(.title.bold())
                if flight.isStaff == true {
                    Label("Staff", systemImage: "star.fill")
                        .font(.caption.bold())
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(.yellow.opacity(0.2), in: Capsule())
                        .foregroundStyle(.yellow)
                } else if flight.isVAMember == true {
                    Label(flight.virtualOrganization ?? "VA", systemImage: "building.2")
                        .font(.caption.bold())
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(.cyan.opacity(0.2), in: Capsule())
                        .foregroundStyle(.cyan)
                }
            }
            if let user = flight.username {
                if let userId = flight.userId {
                    NavigationLink {
                        UserStatsView(userId: userId, username: user)
                    } label: {
                        HStack {
                            Text(user).foregroundStyle(.secondary)
                            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                } else {
                    Text(user).foregroundStyle(.secondary)
                }
            }
            if let role = flight.vaRole {
                Text(role).font(.caption).foregroundStyle(.secondary)
            }
            if let dep = flight.departureIcao, let arr = flight.arrivalIcao {
                HStack(spacing: 8) {
                    NavigationLink {
                        AirportDetailView(icao: dep, server: server)
                    } label: {
                        Text(dep).font(.title3.monospaced().bold())
                    }
                    .tint(.primary)
                    Image(systemName: "arrow.right").foregroundStyle(.secondary)
                    NavigationLink {
                        AirportDetailView(icao: arr, server: server)
                    } label: {
                        Text(arr).font(.title3.monospaced().bold())
                    }
                    .tint(.primary)
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
                        isSelected: true,
                        tint: .accentColor,
                        staff: flight.isStaff ?? false,
                        vaMember: flight.isVAMember ?? false
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

    private var pilotStateRow: some View {
        let phase = FlightPhase.from(flight: flight)
        let kind = flight.pilotStateKind
        let connected = flight.isConnected ?? true
        return HStack(spacing: 8) {
            Label(phase.label, systemImage: "airplane.circle")
                .font(.caption.bold())
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(phase.color.opacity(0.2), in: Capsule())
                .foregroundStyle(phase.color)

            Label(kind.label, systemImage: kind.systemImage)
                .font(.caption.bold())
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(.gray.opacity(0.2), in: Capsule())

            if !connected {
                Label("Disconnected", systemImage: "wifi.exclamationmark")
                    .font(.caption.bold())
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(.red.opacity(0.2), in: Capsule())
                    .foregroundStyle(.red)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var routeSection: some View {
        if let waypoints = vm.plan?.waypoints, !waypoints.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Flight Plan").font(.headline)
                ForEach(waypoints) { wp in
                    HStack {
                        Image(systemName: "mappin.circle").foregroundStyle(.secondary)
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
        if flight.virtualOrganization != nil || flight.vaRole != nil {
            VStack(alignment: .leading, spacing: 6) {
                Text("Pilot").font(.headline)
                if let va = flight.virtualOrganization {
                    LabeledContent("Virtual airline", value: va)
                }
                if let role = flight.vaRole {
                    LabeledContent("Role", value: role)
                }
            }
            .padding()
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    @ViewBuilder
    private var aircraftSection: some View {
        if let aircraft = flight.aircraft {
            VStack(alignment: .leading, spacing: 6) {
                Text("Aircraft").font(.headline)
                LabeledContent("Type", value: aircraft.aircraftName ?? "Unknown")
                LabeledContent("Livery", value: aircraft.liveryName ?? "Unknown")
                if !liveries.isEmpty {
                    Button {
                        showLiveries = true
                    } label: {
                        HStack {
                            Image(systemName: "paintbrush")
                            Text("\(liveries.count) other liveries")
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }
                    }
                    .tint(.primary)
                }
            }
            .padding()
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
            .sheet(isPresented: $showLiveries) {
                NavigationStack {
                    List(liveries) { livery in
                        VStack(alignment: .leading) {
                            Text(livery.name).font(.body)
                            if let aircraft = livery.aircraftName {
                                Text(aircraft).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .navigationTitle(aircraft.aircraftName ?? "Liveries")
                    .navigationBarTitleDisplayMode(.inline)
                }
                .presentationDetents([.medium, .large])
            }
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
