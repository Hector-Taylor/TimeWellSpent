import ManagedSettingsUI
import SwiftUI

struct ShieldConfigurationView: View {
    var body: some View {
        VStack(spacing: 16) {
            Text("TimeWellSpent")
                .font(.title)
                .bold()
            Text("Buy time packs to unlock this app or site.")
                .multilineTextAlignment(.center)
            Button("Open TimeWellSpent") {
                if let url = URL(string: "timewellspent://open") {
                    UIApplication.shared.open(url)
                }
            }
        }
        .padding()
    }
}

class ShieldConfigurationExtension: ManagedSettingsUI.ShieldConfigurationDataSource {
    override func configuration(shielding application: Application) -> ShieldConfiguration? {
        ShieldConfiguration(leading: Text("Time pack required"), trailing: Button(action: {} ) { Text("Open app") }, background: ShieldConfiguration.Background(.blurred))
    }

    override func configuration(shielding webDomain: WebDomain) -> ShieldConfiguration? {
        ShieldConfiguration(leading: Text("Time pack required"), trailing: Button(action: {} ) { Text("Open app") }, background: ShieldConfiguration.Background(.blurred))
    }

    override func configuration(shielding application: Application, in category: ActivityCategory) -> ShieldConfiguration? {
        configuration(shielding: application)
    }

    override func configuration(shielding webDomain: WebDomain, in category: ActivityCategory) -> ShieldConfiguration? {
        configuration(shielding: webDomain)
    }
}
