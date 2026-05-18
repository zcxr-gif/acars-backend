import SwiftUI

struct PlaneAnnotation: View {
    let heading: Double
    let isSelected: Bool

    var body: some View {
        ZStack {
            if isSelected {
                Circle()
                    .fill(.tint.opacity(0.25))
                    .frame(width: 44, height: 44)
            }
            Image(systemName: "airplane")
                .resizable()
                .scaledToFit()
                .frame(width: 18, height: 18)
                .foregroundStyle(isSelected ? Color.accentColor : Color.primary)
                .padding(6)
                .background(
                    Circle()
                        .fill(.ultraThinMaterial)
                        .shadow(radius: isSelected ? 4 : 2)
                )
                .rotationEffect(.degrees(heading - 90))
        }
        .accessibilityLabel("Aircraft heading \(Int(heading)) degrees")
    }
}
