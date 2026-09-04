-keepattributes *Annotation*
-dontwarn org.conscrypt.**

# kotlinx.serialization generates the serializers we call explicitly.
-if @kotlinx.serialization.Serializable class **
-keepclassmembers class <1> {
    static <1>$$serializer INSTANCE;
}
