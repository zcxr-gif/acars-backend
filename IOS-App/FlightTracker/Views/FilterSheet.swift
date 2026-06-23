import SwiftUI

struct FilterSheet: View {
    @Binding var filters: FlightFilters
    @Binding var coloring: PlaneColoringMode
    @EnvironmentObject private var metadata: MetadataService
    @Environment(\.dismiss) private var dismiss

    @State private var aircraftSearch: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Coloring") {
                    Picker("Color planes by", selection: $coloring) {
                        ForEach(PlaneColoringMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    Text(coloring.explanation)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Altitude") {
                    HStack {
                        Text("Min")
                        Spacer()
                        Text("\(Int(filters.minAltitude)) ft").foregroundStyle(.secondary)
                    }
                    Slider(value: $filters.minAltitude, in: 0...45_000, step: 500)

                    HStack {
                        Text("Max")
                        Spacer()
                        Text("\(Int(filters.maxAltitude)) ft").foregroundStyle(.secondary)
                    }
                    Slider(value: $filters.maxAltitude, in: 0...45_000, step: 500)
                }

                Section("Speed") {
                    HStack {
                        Text("Min ground speed")
                        Spacer()
                        Text("\(Int(filters.minSpeed)) kt").foregroundStyle(.secondary)
                    }
                    Slider(value: $filters.minSpeed, in: 0...600, step: 10)
                }

                Section("State") {
                    Toggle("Airborne", isOn: $filters.includeAirborne)
                    Toggle("On ground", isOn: $filters.includeOnGround)
                    Toggle("Connected only", isOn: $filters.connectedOnly)
                }

                Section("Identity") {
                    Toggle("VA members only", isOn: $filters.vaOnly)
                    Toggle("Staff only", isOn: $filters.staffOnly)
                }

                Section("Route") {
                    HStack {
                        Image(systemName: "airplane.departure")
                        TextField("Departure ICAO", text: $filters.departureIcao)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                    }
                    HStack {
                        Image(systemName: "airplane.arrival")
                        TextField("Arrival ICAO", text: $filters.arrivalIcao)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                    }
                }

                Section("Aircraft type") {
                    if filters.aircraftIds.isEmpty {
                        Text("Any aircraft").foregroundStyle(.secondary)
                    } else {
                        Text("\(filters.aircraftIds.count) selected").foregroundStyle(.secondary)
                    }
                    TextField("Search aircraft", text: $aircraftSearch)
                        .autocorrectionDisabled()
                    ForEach(filteredAircraft.prefix(40)) { ac in
                        let selected = filters.aircraftIds.contains(ac.id)
                        Button {
                            if selected {
                                filters.aircraftIds.remove(ac.id)
                            } else {
                                filters.aircraftIds.insert(ac.id)
                            }
                        } label: {
                            HStack {
                                Text(ac.name)
                                Spacer()
                                if selected {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                        }
                        .tint(.primary)
                    }
                }
            }
            .navigationTitle("Filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Reset") { filters = .default }
                        .disabled(!filters.isActive)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }.bold()
                }
            }
            .task { await metadata.loadIfNeeded() }
        }
    }

    private var filteredAircraft: [AircraftType] {
        let q = aircraftSearch.trimmingCharacters(in: .whitespaces).uppercased()
        guard !q.isEmpty else { return metadata.aircraft }
        return metadata.aircraft.filter { $0.name.uppercased().contains(q) }
    }
}
