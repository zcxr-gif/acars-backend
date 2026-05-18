import SwiftUI
import MapKit

struct LiveMapView: View {
    @EnvironmentObject private var vm: MapViewModel
    @State private var selectedFlightId: String?
    @State private var showServerPicker: Bool = false
    @State private var showFilters: Bool = false
    @State private var showLegend: Bool = false

    private var selectedFlight: Flight? {
        guard let id = selectedFlightId else { return nil }
        return vm.flights.first { $0.flightId == id }
    }

    var body: some View {
        ZStack(alignment: .top) {
            Map(position: $vm.cameraPosition, selection: $selectedFlightId) {
                ForEach(vm.flights) { flight in
                    if let coord = flight.coordinate {
                        Annotation(flight.callsign, coordinate: coord) {
                            PlaneAnnotation(
                                heading: flight.position.heading_deg ?? 0,
                                isSelected: selectedFlightId == flight.flightId,
                                tint: PlaneColoring.color(for: flight, mode: vm.coloringMode),
                                staff: flight.isStaff ?? false,
                                vaMember: flight.isVAMember ?? false
                            )
                        }
                        .tag(flight.flightId)
                    }
                }
            }
            .mapStyle(.standard(elevation: .realistic))
            .mapControls {
                MapUserLocationButton()
                MapCompass()
                MapScaleView()
            }
            .ignoresSafeArea(edges: .bottom)

            VStack(spacing: 8) {
                topBar
                if let err = vm.errorMessage {
                    errorBanner(err)
                }
                if showLegend { legend }
                Spacer()
            }
            .padding(.horizontal)
            .padding(.top, 8)
        }
        .sheet(item: Binding(
            get: { selectedFlight },
            set: { if $0 == nil { selectedFlightId = nil } }
        )) { flight in
            NavigationStack {
                FlightDetailView(flight: flight, server: vm.selectedServer)
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showServerPicker) {
            ServerPickerView(selection: vm.selectedServer) { server in
                vm.switchServer(server)
                showServerPicker = false
            }
            .presentationDetents([.fraction(0.3)])
        }
        .sheet(isPresented: $showFilters) {
            FilterSheet(filters: $vm.filters, coloring: $vm.coloringMode)
                .presentationDetents([.large])
        }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            chip {
                Button { showServerPicker = true } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "network")
                        Text(vm.selectedServer.shortName).fontWeight(.medium)
                        Image(systemName: "chevron.down").font(.caption.weight(.bold))
                    }
                }.tint(.primary)
            }

            chip {
                Button { showFilters = true } label: {
                    HStack(spacing: 6) {
                        Image(systemName: vm.filters.isActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                        Text("Filters").fontWeight(.medium)
                        if vm.filters.activeCount > 0 {
                            Text("\(vm.filters.activeCount)")
                                .font(.caption.bold())
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(.tint, in: Capsule())
                                .foregroundStyle(.black)
                        }
                    }
                }.tint(.primary)
            }

            chip {
                Button { withAnimation { showLegend.toggle() } } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "paintpalette")
                        Text(vm.coloringMode.rawValue).fontWeight(.medium)
                    }
                }.tint(.primary)
            }

            Spacer()

            chip {
                HStack(spacing: 6) {
                    Image(systemName: "airplane").imageScale(.small)
                    Text("\(vm.filteredCount)")
                        .fontWeight(.semibold)
                        .contentTransition(.numericText())
                    if vm.filteredCount != vm.totalCount {
                        Text("/ \(vm.totalCount)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private var legend: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(vm.coloringMode.rawValue).font(.caption.bold())
            switch vm.coloringMode {
            case .altitude:
                gradientBar(stops: ["0 ft", "FL150", "FL300", "FL450"], colors: [
                    .init(hue: 0.55, saturation: 0.8, brightness: 0.95),
                    .init(hue: 0.33, saturation: 0.8, brightness: 0.95),
                    .init(hue: 0.10, saturation: 0.8, brightness: 0.95),
                    .init(hue: 0.92, saturation: 0.8, brightness: 0.95),
                ])
            case .speed:
                gradientBar(stops: ["0", "200", "400", "600 kt"], colors: [
                    .init(hue: 0.35, saturation: 0.85, brightness: 0.95),
                    .init(hue: 0.22, saturation: 0.85, brightness: 0.95),
                    .init(hue: 0.08, saturation: 0.85, brightness: 0.95),
                    .init(hue: 0.00, saturation: 0.85, brightness: 0.95),
                ])
            case .phase:
                HStack(spacing: 12) {
                    legendDot(.gray, "Ground")
                    legendDot(.green, "Climb")
                    legendDot(.blue, "Cruise")
                    legendDot(.orange, "Descent")
                }
            case .vaStatus:
                HStack(spacing: 12) {
                    legendDot(.yellow, "Staff")
                    legendDot(.cyan, "VA")
                    legendDot(.gray, "Public")
                }
            }
        }
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private func gradientBar(stops: [String], colors: [Color]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            LinearGradient(colors: colors, startPoint: .leading, endPoint: .trailing)
                .frame(height: 8)
                .clipShape(Capsule())
            HStack {
                ForEach(stops, id: \.self) { stop in
                    Text(stop).font(.caption2).foregroundStyle(.secondary)
                    if stop != stops.last { Spacer() }
                }
            }
        }
    }

    private func legendDot(_ color: Color, _ label: String) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 10, height: 10)
            Text(label).font(.caption)
        }
    }

    @ViewBuilder
    private func chip<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        content()
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .background(.ultraThinMaterial, in: Capsule())
    }

    private func errorBanner(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
            Text(text).font(.caption)
            Spacer()
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}
