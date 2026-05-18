import SwiftUI
import MapKit

struct LiveMapView: View {
    @EnvironmentObject private var vm: MapViewModel
    @State private var selectedFlightId: String?
    @State private var showServerPicker: Bool = false

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
                                isSelected: selectedFlightId == flight.flightId
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
            }
            .padding(.horizontal)
            .padding(.top, 8)
        }
        .sheet(item: Binding(
            get: { selectedFlight },
            set: { if $0 == nil { selectedFlightId = nil } }
        )) { flight in
            FlightDetailSheet(flight: flight, server: vm.selectedServer)
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
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Button {
                showServerPicker = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "network")
                    Text(vm.selectedServer.shortName)
                        .fontWeight(.medium)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                }
                .padding(.vertical, 8)
                .padding(.horizontal, 14)
                .background(.ultraThinMaterial, in: Capsule())
            }
            .tint(.primary)

            Spacer()

            HStack(spacing: 6) {
                Image(systemName: "airplane")
                    .imageScale(.small)
                Text("\(vm.flights.count)")
                    .fontWeight(.semibold)
                    .contentTransition(.numericText())
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 14)
            .background(.ultraThinMaterial, in: Capsule())
        }
    }

    private func errorBanner(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.yellow)
            Text(text).font(.caption)
            Spacer()
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

/// A small wrapper that owns the detail VM so we can `task` against the flight id.
private struct FlightDetailSheet: View {
    let flight: Flight
    let server: AppConfig.Server

    var body: some View {
        NavigationStack {
            FlightDetailView(flight: flight, server: server)
        }
    }
}
